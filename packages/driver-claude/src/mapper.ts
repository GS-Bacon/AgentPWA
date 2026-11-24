// claude CLI の stream-json 出力（1行1件）を DriverEvent に変換する。
// 状態（status）の管理は session.ts が行い、ここでは出力の正規化だけをする。
import type { DriverEvent, PermissionMode } from '@agentpwa/shared';
import { fromClaudePermissionMode, summarizeTool } from './permissions.ts';

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
  private tools = new Map<string, { name: string; summary: string }>();

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
        return { events: [], turnEnded: { isError: Boolean(isError), errors } };
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
    if (msg.parent_tool_use_id) return { events: [] };
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
        const toolId = String(block.id);
        this.tools.set(toolId, { name, summary });
        events.push({ type: 'tool', toolId, name, summary, state: 'running' });
      }
    }
    return { events, activity: true };
  }

  private mapUser(msg: Json): MapResult {
    if (msg.parent_tool_use_id) return { events: [] };
    const content = msg.message?.content;
    if (!Array.isArray(content)) return { events: [] };
    const events: DriverEvent[] = [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolId = String(block.tool_use_id);
      const t = this.tools.get(toolId) ?? { name: 'tool', summary: '' };
      events.push({
        type: 'tool',
        toolId,
        name: t.name,
        summary: t.summary,
        state: block.is_error ? 'failed' : 'done',
        output: truncate(toolResultText(block.content)),
      });
    }
    return { events, activity: events.length > 0 };
  }

  private mapRateLimit(info: Json): DriverEvent[] {
    const w = info?.unifiedWindows;
    if (!w) return [];
    const out: DriverEvent[] = [];
    if (w.five_hour) out.push({ type: 'usage', label: 'セッション枠（5時間）', percent: pct(w.five_hour.utilization), resetsAt: epochToIso(w.five_hour.resetsAt) });
    if (w.seven_day) out.push({ type: 'usage', label: '週間', percent: pct(w.seven_day.utilization), resetsAt: epochToIso(w.seven_day.resetsAt) });
    return out;
  }
}
