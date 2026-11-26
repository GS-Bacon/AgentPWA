// claude CLI の stream-json 出力（1行1件）を DriverEvent に変換する。
// 状態（status）の管理は session.ts が行い、ここでは出力の正規化だけをする。
import type { DriverEvent, PermissionMode } from '@agentpwa/shared';
import { fromClaudePermissionMode, summarizeTool, toolPaths } from './permissions.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface MapResult {
  events: DriverEvent[];
  /** system/init で分かった値 */
  init?: { sessionId: string; apiKeySource?: string; model?: string };
  /** system/init・system/status で分かった、そのときの権限モード（重複の間引きは session.ts が行う） */
  permissionMode?: PermissionMode;
  /** エージェントが作業している印（status を running に戻すきっかけ） */
  activity?: boolean;
  /** ターンが終わった（result を受け取った） */
  turnEnded?: { isError: boolean; errors: string[] };
}

const MAX_OUTPUT = 4000;

function truncate(s: string, n = MAX_OUTPUT): string {
  return s.length > n ? s.slice(0, n) + `\n…（${s.length - n} 文字省略）` : s;
}

function toolResultText(content: Json): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? String(c.text ?? '') : c?.type ? `[${c.type}]` : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

type SubagentEv = Extract<DriverEvent, { type: 'subagent' }>;

/** サブエージェントを起動するツール（CLI の版によって名前が違う） */
export function isSubagentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent';
}

function oneLine(s: string, n = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** task_updated / task_notification の status をプロトコルの状態にする（実行中のものは undefined） */
function subagentState(status: unknown): SubagentEv['state'] | undefined {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return 'stopped';
    default:
      return undefined;
  }
}

function pct(v: unknown): number | undefined {
  return typeof v === 'number' ? Math.round(v * 100) : undefined;
}

function epochToIso(v: unknown): string | undefined {
  return typeof v === 'number' ? new Date(v * 1000).toISOString() : undefined;
}

export class StreamMapper {
  /** ストリーミング中のメッセージ ID（stream_event の message_start で分かる） */
  private curMessageId = '';
  /** content block の index → プロトコルの messageId */
  private blockIds = new Map<number, string>();
  /** 完成版の assistant メッセージを待っている text block の messageId（API メッセージ ID ごとに FIFO） */
  private pendingText = new Map<string, string[]>();
  private textCounter = 0;
  private tools = new Map<string, { name: string; summary: string; paths?: string[]; parentToolId?: string }>();
  /** サブエージェント（起動したツールの toolId → 最後に送った状態） */
  private subagents = new Map<string, SubagentEv>();
  /** CLI の task_id → サブエージェントを起動したツールの toolId（task_updated には toolId が無いため） */
  private taskTools = new Map<string, string>();
  /** 動いているバックグラウンド作業（サブエージェント・シェルなど）の task_id */
  private runningTasks = new Set<string>();
  /** コンテキストの使用量（本流の直近の API 呼び出しのモデルとトークン数、最後に送った値） */
  private ctxModel = '';
  private ctxUsed = 0;
  /** モデル → コンテキストの上限（result の modelUsage[].contextWindow で分かる） */
  private ctxWindows = new Map<string, number>();
  private ctxSent = '';

  map(msg: Json): MapResult {
    switch (msg?.type) {
      case 'system': {
        // system/init と system/status は、そのときの権限モードを持つ（計画モードの終了など CLI 自身の変更も届く）
        const mode = msg.subtype === 'init' || msg.subtype === 'status' ? fromClaudePermissionMode(msg.permissionMode) : undefined;
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          return {
            events: [{ type: 'resume_token', token: msg.session_id }],
            init: { sessionId: msg.session_id, apiKeySource: msg.apiKeySource, model: msg.model },
            permissionMode: mode,
          };
        }
        if (typeof msg.subtype === 'string' && msg.subtype.startsWith('task_')) return { events: this.mapTask(msg) };
        return { events: [], permissionMode: mode };
      }
      case 'stream_event':
        return this.mapStreamEvent(msg);
      case 'assistant':
        return this.mapAssistant(msg);
      case 'user':
        return this.mapUser(msg);
      case 'result': {
        const isError = Boolean(msg.is_error) || (msg.subtype && msg.subtype !== 'success');
        const errors: string[] = Array.isArray(msg.errors) ? msg.errors.map(String) : [];
        if (isError && errors.length === 0 && typeof msg.result === 'string') errors.push(msg.result);
        return { events: this.mapResultContext(msg), turnEnded: { isError: Boolean(isError), errors } };
      }
      case 'rate_limit_event':
        return { events: this.mapRateLimit(msg.rate_limit_info) };
      default:
        return { events: [] };
    }
  }

  private mapStreamEvent(msg: Json): MapResult {
    if (msg.parent_tool_use_id) return { events: [] };
    const e = msg.event ?? {};
    switch (e.type) {
      case 'message_start':
        this.curMessageId = String(e.message?.id ?? `m${Date.now()}`);
        this.blockIds.clear();
        return { events: [], activity: true };
      case 'content_block_start':
        if (e.content_block?.type === 'text') {
          const id = `${this.curMessageId}:${e.index}`;
          this.blockIds.set(e.index, id);
          const q = this.pendingText.get(this.curMessageId) ?? [];
          q.push(id);
          this.pendingText.set(this.curMessageId, q);
        }
        return { events: [], activity: true };
      case 'content_block_delta': {
        if (e.delta?.type !== 'text_delta') return { events: [] };
        const id = this.blockIds.get(e.index);
        if (!id || !e.delta.text) return { events: [] };
        return { events: [{ type: 'message_delta', messageId: id, text: String(e.delta.text) }], activity: true };
      }
      default:
        return { events: [] };
    }
  }

  private mapAssistant(msg: Json): MapResult {
    if (msg.parent_tool_use_id) return { events: this.mapSubAssistant(msg, String(msg.parent_tool_use_id)) };
    const m = msg.message ?? {};
    const apiId = String(m.id ?? `m${Date.now()}`);
    const events: DriverEvent[] = [];
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type === 'text') {
        const text = String(block.text ?? '');
        const q = this.pendingText.get(apiId);
        const id = q?.shift() ?? `${apiId}:t${this.textCounter++}`;
        if (q && q.length === 0) this.pendingText.delete(apiId);
        if (text.trim()) events.push({ type: 'message', messageId: id, role: 'assistant', text });
      } else if (block?.type === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const summary = summarizeTool(name, block.input ?? {});
        const paths = toolPaths(name, block.input ?? {});
        const toolId = String(block.id);
        this.tools.set(toolId, { name, summary, paths });
        events.push({ type: 'tool', toolId, name, summary, ...(paths ? { paths } : {}), state: 'running' });
        if (isSubagentTool(name)) {
          const input = block.input ?? {};
          const ev = this.updateSubagent(toolId, {
            agentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
            description: String(input.description ?? ''),
            prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
            state: 'running',
          });
          if (ev) events.push(ev);
        }
      }
    }
    const ctx = this.assistantContext(m);
    if (ctx) events.push(ctx);
    return { events, activity: true };
  }

  /**
   * 本流の assistant メッセージの usage から、コンテキストの使用量を求める。
   * 入力（キャッシュの読み書きを含む）と出力の合計が、次の呼び出しで文脈に入る量に近い。
   * /context などの出力（モデル <synthetic>）は usage が空なので数えない。
   */
  private assistantContext(m: Json): DriverEvent | undefined {
    const u = m.usage;
    if (!u || m.model === '<synthetic>') return undefined;
    const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
    const used = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens);
    if (used === 0) return undefined;
    if (typeof m.model === 'string' && m.model) this.ctxModel = m.model;
    this.ctxUsed = used;
    return this.contextEvent();
  }

  /** result の modelUsage から、モデルごとのコンテキストの上限を覚える */
  private mapResultContext(msg: Json): DriverEvent[] {
    const mu = msg.modelUsage;
    if (!mu || typeof mu !== 'object') return [];
    for (const [model, v] of Object.entries<Json>(mu)) {
      if (typeof v?.contextWindow === 'number' && v.contextWindow > 0) this.ctxWindows.set(model, v.contextWindow);
    }
    const ev = this.contextEvent();
    return ev ? [ev] : [];
  }

  /** 前に送った値と変わったときだけ context を作る */
  private contextEvent(): DriverEvent | undefined {
    if (this.ctxUsed === 0) return undefined;
    const windowTokens = this.ctxWindows.get(this.ctxModel);
    const key = `${this.ctxUsed}/${windowTokens ?? ''}`;
    if (key === this.ctxSent) return undefined;
    this.ctxSent = key;
    return windowTokens ? { type: 'context', usedTokens: this.ctxUsed, windowTokens } : { type: 'context', usedTokens: this.ctxUsed };
  }

  /** サブエージェント内の assistant メッセージ（完成版だけ。途中経過の stream_event は CLI が送らない） */
  private mapSubAssistant(msg: Json, parentToolId: string): DriverEvent[] {
    const m = msg.message ?? {};
    const apiId = String(m.id ?? `m${Date.now()}`);
    const events: DriverEvent[] = [];
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type === 'text') {
        const text = String(block.text ?? '');
        if (text.trim()) events.push({ type: 'message', messageId: `${apiId}:s${this.textCounter++}`, role: 'assistant', text, parentToolId });
      } else if (block?.type === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const summary = summarizeTool(name, block.input ?? {});
        const paths = toolPaths(name, block.input ?? {});
        const toolId = String(block.id);
        this.tools.set(toolId, { name, summary, paths, parentToolId });
        events.push({ type: 'tool', toolId, name, summary, ...(paths ? { paths } : {}), state: 'running', parentToolId });
      }
    }
    return events;
  }

  /** system/task_*（サブエージェントの起動・進み具合・終了）を subagent イベントにする */
  private mapTask(msg: Json): DriverEvent[] {
    const taskId = typeof msg.task_id === 'string' ? msg.task_id : undefined;
    // 種類を問わず、動いているバックグラウンド作業を数えておく（使われていないプロセスを止めてよいかの判断に使う）
    if (taskId) {
      if (msg.subtype === 'task_started') this.runningTasks.add(taskId);
      else if (msg.subtype === 'task_updated' || msg.subtype === 'task_notification') {
        if (subagentState(msg.subtype === 'task_updated' ? msg.patch?.status : msg.status)) this.runningTasks.delete(taskId);
      }
    }
    let toolId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined;
    if (toolId && taskId) this.taskTools.set(taskId, toolId);
    if (!toolId && taskId) toolId = this.taskTools.get(taskId);
    if (!toolId) return [];
    // サブエージェント以外のバックグラウンド作業（シェルなど）は扱わない
    if (msg.task_type && msg.task_type !== 'local_agent' && !this.subagents.has(toolId)) return [];
    switch (msg.subtype) {
      case 'task_started': {
        const ev = this.updateSubagent(toolId, {
          agentType: typeof msg.subagent_type === 'string' ? msg.subagent_type : undefined,
          description: String(msg.description ?? ''),
          prompt: typeof msg.prompt === 'string' ? msg.prompt : undefined,
          state: 'running',
        });
        return ev ? [ev] : [];
      }
      case 'task_progress': {
        if (!this.subagents.has(toolId)) return [];
        const ev = this.updateSubagent(toolId, { progress: oneLine(String(msg.description ?? '')) || undefined });
        return ev ? [ev] : [];
      }
      case 'task_updated':
      case 'task_notification': {
        const state = subagentState(msg.subtype === 'task_updated' ? msg.patch?.status : msg.status);
        if (!state || !this.subagents.has(toolId)) return [];
        const result = typeof msg.summary === 'string' && msg.summary.trim() ? truncate(msg.summary) : undefined;
        const ev = this.updateSubagent(toolId, { state, progress: undefined, result });
        return ev ? [ev] : [];
      }
      default:
        return [];
    }
  }

  /**
   * サブエージェントの状態を更新し、変わっていれば送るイベントを返す。
   * patch の undefined は「変えない」（progress だけは「消す」）。終わった後に running へは戻さない。
   */
  private updateSubagent(toolId: string, patch: Partial<Omit<SubagentEv, 'type' | 'toolId'>>): SubagentEv | undefined {
    const prev = this.subagents.get(toolId);
    if (prev && prev.state !== 'running' && patch.state === 'running') return undefined;
    const next: SubagentEv = { type: 'subagent', toolId, description: '', state: 'running', ...prev };
    if (patch.agentType) next.agentType = patch.agentType;
    if (patch.description) next.description = patch.description;
    if (patch.prompt) next.prompt = patch.prompt;
    if (patch.state) next.state = patch.state;
    if (patch.result) next.result = patch.result;
    if ('progress' in patch) {
      if (patch.progress) next.progress = patch.progress;
      else delete next.progress;
    }
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return undefined;
    this.subagents.set(toolId, next);
    // 指示（prompt）は長いので、変わったときだけ送る（省いたものは前の値のまま）
    if (prev?.prompt && prev.prompt === next.prompt) {
      const { prompt: _p, ...rest } = next;
      return rest;
    }
    return next;
  }

  /** バックグラウンド作業（サブエージェント・シェルなど）が動いているか */
  hasRunningTasks(): boolean {
    return this.runningTasks.size > 0;
  }

  /** まだ動いているサブエージェントを止まったことにする（CLI のプロセスが終わったとき） */
  stopSubagents(): DriverEvent[] {
    this.runningTasks.clear();
    const out: DriverEvent[] = [];
    for (const [toolId, s] of this.subagents) {
      if (s.state !== 'running') continue;
      const ev = this.updateSubagent(toolId, { state: 'stopped', progress: undefined });
      if (ev) out.push(ev);
    }
    return out;
  }

  private mapUser(msg: Json): MapResult {
    const sub = msg.parent_tool_use_id ? String(msg.parent_tool_use_id) : undefined;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return { events: [] };
    const events: DriverEvent[] = [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolId = String(block.tool_use_id);
      const t = this.tools.get(toolId) ?? { name: 'tool', summary: '', parentToolId: sub };
      const output = truncate(toolResultText(block.content));
      events.push({
        type: 'tool',
        toolId,
        name: t.name,
        summary: t.summary,
        ...(t.paths ? { paths: t.paths } : {}),
        state: block.is_error ? 'failed' : 'done',
        output,
        ...(t.parentToolId ? { parentToolId: t.parentToolId } : {}),
      });
      // 前面で動いたサブエージェントは、ツールの結果が届いた時点で終わっている（裏で動くものは task_notification で終わる）
      const r = msg.tool_use_result;
      const async = r?.isAsync === true || r?.status === 'async_launched';
      if (!sub && isSubagentTool(t.name) && !async && this.subagents.get(toolId)?.state === 'running') {
        const ev = this.updateSubagent(toolId, { state: block.is_error ? 'failed' : 'done', progress: undefined, result: output || undefined });
        if (ev) events.push(ev);
      }
    }
    // サブエージェント内の動きでは、セッションの状態（running）を変えない
    return { events, activity: !sub && events.length > 0 };
  }

  private mapRateLimit(info: Json): DriverEvent[] {
    const w = info?.unifiedWindows;
    if (!w) return [];
    const out: DriverEvent[] = [];
    const win = (x: Json, label: string, windowMinutes: number): DriverEvent => ({ type: 'usage', label, percent: pct(x.utilization), resetsAt: epochToIso(x.resetsAt), windowMinutes });
    if (w.five_hour) out.push(win(w.five_hour, 'セッション枠（5時間）', 300));
    if (w.seven_day) out.push(win(w.seven_day, '週間', 7 * 24 * 60));
    // CLI が「Fable limit」と呼ぶ週間枠。その枠がある契約のときだけ届く。
    if (w.seven_day_overage_included) out.push(win(w.seven_day_overage_included, 'Fable（週間）', 7 * 24 * 60));
    return out;
  }
}
