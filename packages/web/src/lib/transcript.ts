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
  | { kind: 'user'; key: string; text: string; attachments?: AttachmentInfo[] }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean }
  | { kind: 'tools'; key: string; tools: ToolItem[] }
  | { kind: 'approval'; key: string; req: ApprovalEv; at: string; decision?: ApprovalDecision }
  | { kind: 'question'; key: string; req: QuestionEv; at: string; resolved: boolean }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'error'; key: string; text: string };

export function buildItems(events: SessionEvent[]): Item[] {
  const items: Item[] = [];
  const msgIndex = new Map<string, number>();
  const toolIndex = new Map<string, { item: number; tool: number }>();
  const approvalIndex = new Map<string, number>();
  const questionIndex = new Map<string, number>();
  let mode: PermissionMode | undefined;
  /** 直前のモデルとエフォート（'model|effort'） */
  let model: string | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case 'message': {
        if (ev.role === 'user') {
          items.push({ kind: 'user', key: `u${ev.seq}`, text: ev.text, attachments: ev.attachments });
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

/** unified diff を行ごとの種類に分ける */
export function diffLines(diff: string): { cls: string; text: string }[] {
  return diff.split('\n').map((text) => ({
    cls: text.startsWith('@@') ? 'l-hunk' : text.startsWith('+') && !text.startsWith('+++') ? 'l-add' : text.startsWith('-') && !text.startsWith('---') ? 'l-del' : '',
    text,
  }));
}
