// イベント列から、会話の表示用の項目を組み立てる。
import type { ApprovalDecision, AttachmentInfo, DriverEvent, PermissionMode, SessionEvent } from '@agentpwa/shared';
import { MODE_LABEL } from './format.ts';
import { EFFORT_LABEL } from './models.ts';

type ApprovalEv = Extract<DriverEvent, { type: 'approval_request' }>;
type QuestionEv = Extract<DriverEvent, { type: 'question' }>;

export interface ToolItem {
  toolId: string;
  name: string;
  summary: string;
  /** 対象ファイルのパス（ファイルビュワーで開く） */
  paths?: string[];
  state: 'running' | 'done' | 'failed';
  output?: string;
}

export type Item =
  | {
      kind: 'user';
      key: string;
      text: string;
      attachments?: AttachmentInfo[];
      messageId: string;
      /** 送った時刻 */
      at: string;
      /** ここまで巻き戻せる・ここからフォークできる（v11） */
      rewindable: boolean;
    }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean }
  | { kind: 'tools'; key: string; tools: ToolItem[] }
  | { kind: 'approval'; key: string; req: ApprovalEv; at: string; decision?: ApprovalDecision }
  | { kind: 'question'; key: string; req: QuestionEv; at: string; resolved: boolean }
  /** サブエージェントを起動した行（中身はサブペインに出す。状態は SubagentInfo を見る） */
  | { kind: 'subagent'; key: string; toolId: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'error'; key: string; text: string };

type SubagentEv = Extract<DriverEvent, { type: 'subagent' }>;

export interface SubagentInfo {
  toolId: string;
  agentType?: string;
  description: string;
  prompt?: string;
  state: SubagentEv['state'];
  progress?: string;
  result?: string;
  /** サブエージェントの中の会話とツール */
  items: Item[];
  /** サブエージェントが使ったツールの toolId（許可要求がどのサブエージェントのものか調べるのに使う） */
  toolIds: Set<string>;
}

/** イベントが属するサブエージェント（起動したツールの toolId）。本流のものは undefined */
function parentOf(ev: SessionEvent): string | undefined {
  return ev.type === 'message' || ev.type === 'message_delta' || ev.type === 'tool' ? ev.parentToolId : undefined;
}

/** サブエージェントごとに、状態と中身をまとめる（起動した順） */
export function buildSubagents(events: SessionEvent[]): SubagentInfo[] {
  const subs = new Map<string, SubagentInfo>();
  const childEvents = new Map<string, SessionEvent[]>();
  for (const ev of events) {
    if (ev.type === 'subagent') {
      const prev = subs.get(ev.toolId);
      subs.set(ev.toolId, {
        toolId: ev.toolId,
        agentType: ev.agentType ?? prev?.agentType,
        description: ev.description || prev?.description || '',
        prompt: ev.prompt ?? prev?.prompt,
        state: ev.state,
        progress: ev.progress,
        result: ev.result ?? prev?.result,
        items: [],
        toolIds: prev?.toolIds ?? new Set(),
      });
      continue;
    }
    const parent = parentOf(ev);
    if (!parent) continue;
    const list = childEvents.get(parent) ?? [];
    list.push(ev);
    childEvents.set(parent, list);
  }
  const ids = new Set(subs.keys());
  for (const [toolId, list] of childEvents) {
    const s = subs.get(toolId);
    if (!s) continue;
    s.items = buildItems(list, { inner: true, subagentIds: ids });
    for (const ev of list) if (ev.type === 'tool') s.toolIds.add(ev.toolId);
  }
  return [...subs.values()];
}

/**
 * 本流の会話の項目を組み立てる。サブエージェントの中のイベント（parentToolId 付き）は除き、
 * サブエージェントを起動したツールは 'subagent' の行にする。
 * inner のときは、サブエージェントの中身として組み立てる（parentToolId で除かない。
 * サブエージェントの中から起動したサブエージェントは、subagentIds で渡す）。
 */
export function buildItems(events: SessionEvent[], opts: { inner?: boolean; subagentIds?: Set<string> } = {}): Item[] {
  const inner = opts.inner ?? false;
  const subagentIds = opts.subagentIds ?? new Set<string>();
  if (!opts.subagentIds) for (const ev of events) if (ev.type === 'subagent') subagentIds.add(ev.toolId);
  const items: Item[] = [];
  const msgIndex = new Map<string, number>();
  const toolIndex = new Map<string, { item: number; tool: number }>();
  const approvalIndex = new Map<string, number>();
  const questionIndex = new Map<string, number>();
  let mode: PermissionMode | undefined;
  /** 直前のモデルとエフォート（'model|effort'） */
  let model: string | undefined;

  const subagentShown = new Set<string>();
  /** ユーザーの発言の messageId → items の位置（巻き戻しで使う） */
  const userIndex = new Map<string, number>();

  for (const ev of events) {
    if (!inner && parentOf(ev)) continue;
    switch (ev.type) {
      case 'message': {
        if (ev.role === 'user') {
          userIndex.set(ev.messageId, items.length);
          items.push({ kind: 'user', key: `u${ev.seq}`, text: ev.text, attachments: ev.attachments, messageId: ev.messageId, at: ev.at, rewindable: ev.rewindable === true });
          break;
        }
        const i = msgIndex.get(ev.messageId);
        if (i !== undefined) items[i] = { kind: 'assistant', key: (items[i] as { key: string }).key, text: ev.text, streaming: false };
        else {
          msgIndex.set(ev.messageId, items.length);
          items.push({ kind: 'assistant', key: `a${ev.seq}`, text: ev.text, streaming: false });
        }
        break;
      }
      case 'message_delta': {
        const i = msgIndex.get(ev.messageId);
        if (i !== undefined) {
          const it = items[i] as Extract<Item, { kind: 'assistant' }>;
          items[i] = { ...it, text: it.text + ev.text };
        } else {
          msgIndex.set(ev.messageId, items.length);
          items.push({ kind: 'assistant', key: `a${ev.seq}`, text: ev.text, streaming: true });
        }
        break;
      }
      case 'tool': {
        if (subagentIds.has(ev.toolId)) {
          if (!subagentShown.has(ev.toolId)) {
            subagentShown.add(ev.toolId);
            items.push({ kind: 'subagent', key: `s${ev.seq}`, toolId: ev.toolId });
          }
          break;
        }
        const tool: ToolItem = { toolId: ev.toolId, name: ev.name, summary: ev.summary, paths: ev.paths, state: ev.state, output: ev.output };
        const pos = toolIndex.get(ev.toolId);
        if (pos) {
          const it = items[pos.item] as Extract<Item, { kind: 'tools' }>;
          const tools = [...it.tools];
          tools[pos.tool] = { ...tools[pos.tool], ...tool, paths: tool.paths ?? tools[pos.tool].paths, output: tool.output ?? tools[pos.tool].output };
          items[pos.item] = { ...it, tools };
          break;
        }
        const last = items[items.length - 1];
        if (last?.kind === 'tools') {
          toolIndex.set(ev.toolId, { item: items.length - 1, tool: last.tools.length });
          items[items.length - 1] = { ...last, tools: [...last.tools, tool] };
        } else {
          toolIndex.set(ev.toolId, { item: items.length, tool: 0 });
          items.push({ kind: 'tools', key: `t${ev.seq}`, tools: [tool] });
        }
        break;
      }
      case 'approval_request': {
        const { sessionId: _s, seq: _q, at, ...req } = ev;
        approvalIndex.set(ev.requestId, items.length);
        items.push({ kind: 'approval', key: `p${ev.seq}`, req: req as ApprovalEv, at });
        break;
      }
      case 'approval_resolved': {
        const i = approvalIndex.get(ev.requestId);
        if (i !== undefined) items[i] = { ...(items[i] as Extract<Item, { kind: 'approval' }>), decision: ev.decision };
        break;
      }
      case 'question': {
        const { sessionId: _s, seq: _q, at, ...req } = ev;
        questionIndex.set(ev.requestId, items.length);
        items.push({ kind: 'question', key: `q${ev.seq}`, req: req as QuestionEv, at, resolved: false });
        break;
      }
      case 'question_resolved': {
        const i = questionIndex.get(ev.requestId);
        if (i !== undefined) items[i] = { ...(items[i] as Extract<Item, { kind: 'question' }>), resolved: true };
        break;
      }
      case 'rewound': {
        // 巻き戻した発言から後を消す（エージェントの文脈からも外れている）
        // （rewoundEvents を通したイベント列では、すでに消えている）
        const p = userIndex.get(ev.messageId);
        if (p !== undefined) {
          items.length = p;
          for (const m of [msgIndex, approvalIndex, questionIndex, userIndex]) for (const [k, i] of m) if (i >= p) m.delete(k);
          for (const [k, pos] of toolIndex) if (pos.item >= p) toolIndex.delete(k);
        }
        items.push({ kind: 'note', key: `r${ev.seq}`, text: 'ここまで巻き戻しました' });
        break;
      }
      case 'status':
        if (ev.reason) items.push({ kind: 'note', key: `n${ev.seq}`, text: ev.reason });
        else if (ev.status === 'stopped') items.push({ kind: 'note', key: `n${ev.seq}`, text: 'セッションを停止しました' });
        break;
      case 'error':
        items.push({ kind: 'error', key: `e${ev.seq}`, text: ev.message });
        break;
      case 'permission_mode':
        // 起動・再開のたびに同じモードが届くので、変わったときだけ出す
        if (mode !== undefined && ev.mode !== mode) items.push({ kind: 'note', key: `m${ev.seq}`, text: `権限モードを「${MODE_LABEL[ev.mode]}」にしました` });
        mode = ev.mode;
        break;
      case 'model': {
        // こちらも起動・再開のたびに届くので、変わったときだけ出す
        const next = `${ev.model ?? ''}|${ev.effort ?? ''}`;
        if (model !== undefined && next !== model) {
          const parts: string[] = [];
          const [prevModel, prevEffort] = model.split('|');
          if ((ev.model ?? '') !== prevModel) parts.push(`モデルを「${ev.model ?? '既定'}」`);
          if ((ev.effort ?? '') !== prevEffort) parts.push(`エフォートを「${ev.effort ? EFFORT_LABEL[ev.effort] : '既定'}」`);
          items.push({ kind: 'note', key: `md${ev.seq}`, text: `${parts.join('、')}にしました` });
        }
        model = next;
        break;
      }
      default:
        break;
    }
  }
  // 状態が変わらないまま終わったツール（中断など）は実行中のままにしない
  return items;
}

/**
 * 巻き戻し（rewound）を反映したイベント列（v11）。巻き戻した発言から rewound の直前までを除き、rewound は
 * その発言のあった位置に残す（「ここまで巻き戻しました」の表示に使う）。サブエージェントの一覧なども、これを使って数える。
 */
export function rewoundEvents(events: SessionEvent[]): SessionEvent[] {
  if (!events.some((e) => e.type === 'rewound')) return events;
  const out: SessionEvent[] = [];
  const userPos = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === 'rewound') {
      const p = userPos.get(ev.messageId);
      if (p !== undefined) {
        out.length = p;
        for (const [id, i] of userPos) if (i >= p) userPos.delete(id);
      }
    } else if (ev.type === 'message' && ev.role === 'user') {
      userPos.set(ev.messageId, out.length);
    }
    out.push(ev);
  }
  return out;
}

/** unified diff を行ごとの種類に分ける */
export function diffLines(diff: string): { cls: string; text: string }[] {
  return diff.split('\n').map((text) => ({
    cls: text.startsWith('@@') ? 'l-hunk' : text.startsWith('+') && !text.startsWith('+++') ? 'l-add' : text.startsWith('-') && !text.startsWith('---') ? 'l-del' : '',
    text,
  }));
}
