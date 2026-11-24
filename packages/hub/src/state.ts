// セッションの状態管理（純粋関数）。保存や配信からは切り離して単体テストする。
import type { AgentKind, EffortLevel, PermissionMode, SessionEvent, SessionStatus } from '@agentpwa/shared';
import type { ApprovalRequest, QuestionRequest, Rank, SessionSummary } from './api.ts';

export interface SessionRecord {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  folderName: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  status: SessionStatus;
  statusReason?: string;
  statusSince: string;
  createdAt: string;
  updatedAt: string;
  resumeToken?: string;
  lastSeq: number;
  /** ユーザーが読んだ位置（seq） */
  readSeq: number;
  /** 最後にターンが終わった（idle になった）位置。readSeq より後なら「完了・未読」 */
  turnEndSeq: number;
  archived: boolean;
  activity?: string;
  lastError?: string;
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: QuestionRequest[];
}

const ACTIVE: SessionStatus[] = ['starting', 'running', 'waiting_approval', 'waiting_input'];
/** ここから idle に戻ったらターン終了とみなす（starting → idle は起動しただけなので含めない） */
const WORKING: SessionStatus[] = ['running', 'waiting_approval', 'waiting_input'];

export function newRecord(p: {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  folderName: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  now: string;
}): SessionRecord {
  return {
    ...p,
    status: 'starting',
    statusSince: p.now,
    createdAt: p.now,
    updatedAt: p.now,
    lastSeq: 0,
    readSeq: 0,
    turnEndSeq: 0,
    archived: false,
    pendingApprovals: [],
    pendingQuestions: [],
  };
}

function oneLine(s: string, n = 80): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

/** イベントを1件適用した新しいレコードを返す。 */
export function applyEvent(rec: SessionRecord, ev: SessionEvent): SessionRecord {
  const r: SessionRecord = { ...rec, lastSeq: Math.max(rec.lastSeq, ev.seq), updatedAt: ev.at };
  switch (ev.type) {
    case 'status': {
      if (ev.status !== rec.status) {
        r.status = ev.status;
        r.statusSince = ev.at;
        // 作業中から idle に戻ったらターン終了（完了・未読の対象）
        if (ev.status === 'idle' && WORKING.includes(rec.status)) r.turnEndSeq = ev.seq;
      }
      r.statusReason = ev.reason;
      if (ev.status === 'stopped' || ev.status === 'idle') {
        r.pendingApprovals = [];
        r.pendingQuestions = [];
      }
      if (ev.status === 'running') r.lastError = undefined;
      break;
    }
    case 'approval_request': {
      const { sessionId: _s, seq: _q, ...rest } = ev;
      r.pendingApprovals = [...rec.pendingApprovals.filter((a) => a.requestId !== ev.requestId), rest];
      r.activity = oneLine(ev.command ? `${ev.title}: ${ev.command}` : ev.title);
      break;
    }
    case 'approval_resolved':
      r.pendingApprovals = rec.pendingApprovals.filter((a) => a.requestId !== ev.requestId);
      break;
    case 'question': {
      const { sessionId: _s, seq: _q, ...rest } = ev;
      r.pendingQuestions = [...rec.pendingQuestions.filter((q) => q.requestId !== ev.requestId), rest];
      r.activity = oneLine(ev.prompt);
      break;
    }
    case 'question_resolved':
      r.pendingQuestions = rec.pendingQuestions.filter((q) => q.requestId !== ev.requestId);
      break;
    case 'resume_token':
      r.resumeToken = ev.token;
      break;
    case 'permission_mode':
      // Driver が報告した「現在のモード」。次に起動・再開するときもこの値を渡す
      r.permissionMode = ev.mode;
      break;
    case 'model':
      // Driver が報告した「現在のモデルとエフォート」。次に起動・再開するときもこの値を渡す
      r.model = ev.model;
      r.effort = ev.effort;
      break;
    case 'tool':
      r.activity = oneLine(`${ev.name} ${ev.summary}`);
      break;
    case 'message':
      if (ev.role === 'assistant') r.activity = oneLine(ev.text);
      // 最初の指示なしで始めたセッションは、最初のユーザー発言を名前にする
      else if (rec.title === DEFAULT_TITLE) r.title = titleFromPrompt(ev.text);
      break;
    case 'error':
      r.lastError = ev.message;
      break;
    default:
      break;
  }
  return r;
}

export function isUnread(rec: Pick<SessionRecord, 'status' | 'turnEndSeq' | 'readSeq'>): boolean {
  return rec.status === 'idle' && rec.turnEndSeq > rec.readSeq;
}

export function rankOf(rec: SessionRecord): Rank {
  switch (rec.status) {
    case 'waiting_approval':
      return 1;
    case 'waiting_input':
      return 2;
    case 'idle':
      return isUnread(rec) ? 3 : 5;
    case 'running':
    case 'starting':
      return 4;
    default:
      return 5;
  }
}

/**
 * 並べ替えの比較関数。
 * 順位の小さい順。同じ順位の中では待ちが長い順（statusSince の古い順）。
 * ただし 5（アイドル・停止）は「待ち」ではないので、最近動いた順にする。
 */
export function compareRecords(a: SessionRecord, b: SessionRecord): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra - rb;
  if (ra === 5) return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  return a.statusSince.localeCompare(b.statusSince) || a.id.localeCompare(b.id);
}

export function sortRecords(list: SessionRecord[]): SessionRecord[] {
  return [...list].sort(compareRecords);
}

/** 既読にする。seq を省略すると最新まで読んだことにする。 */
export function markRead(rec: SessionRecord, seq?: number): SessionRecord {
  const target = Math.min(seq ?? rec.lastSeq, rec.lastSeq);
  if (target <= rec.readSeq) return rec;
  return { ...rec, readSeq: target };
}

/**
 * Hub の起動時に、前回の Hub で動いていたセッションを整える。
 * 子プロセスは Hub と一緒に終わっているので、作業中だったものは stopped にする。
 * idle のものはそのまま（次の送信で resume_token から再開する）。
 * 状態を変えた場合は、記録すべき status イベント（seq/at なし）を返す。
 */
export function recoverAfterRestart(rec: SessionRecord): { status: SessionStatus; reason: string } | null {
  if (ACTIVE.includes(rec.status)) {
    return { status: 'stopped', reason: 'Hub の再起動で中断されました' };
  }
  return null;
}

export function toSummary(rec: SessionRecord, extra: { machine: string; live: boolean }): SessionSummary {
  return {
    id: rec.id,
    agent: rec.agent,
    title: rec.title,
    cwd: rec.cwd,
    folderName: rec.folderName,
    machine: extra.machine,
    model: rec.model,
    effort: rec.effort,
    permissionMode: rec.permissionMode,
    status: rec.status,
    statusReason: rec.statusReason,
    statusSince: rec.statusSince,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastSeq: rec.lastSeq,
    readSeq: rec.readSeq,
    unread: isUnread(rec),
    rank: rankOf(rec),
    resumable: Boolean(rec.resumeToken),
    live: extra.live,
    archived: rec.archived,
    activity: rec.activity,
    lastError: rec.lastError,
    pendingApprovals: rec.pendingApprovals,
    pendingQuestions: rec.pendingQuestions,
  };
}

/** セッション名の既定値: 最初の指示の1行目 */
export const DEFAULT_TITLE = '新しいセッション';

export function titleFromPrompt(prompt: string | undefined): string {
  const t = oneLine(prompt ?? '', 40);
  return t || DEFAULT_TITLE;
}
