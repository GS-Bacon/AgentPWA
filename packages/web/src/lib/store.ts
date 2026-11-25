// 画面の状態（セッション一覧・イベント）と Hub との WebSocket 接続。
// useSyncExternalStore で購読する小さなストア。
import { useSyncExternalStore } from 'react';
import type { AgentKind, SessionEvent } from '@agentpwa/shared';
import type { HubInfo, ProjectColor, ServerMessage, SessionSummary, UsageInfo } from '@agentpwa/hub/api';
import { api } from './api.ts';

export interface State {
  connected: boolean;
  /** 一度でも接続できたか（最初の読み込み表示に使う） */
  ready: boolean;
  info: HubInfo | null;
  sessions: Record<string, SessionSummary>;
  /** 読み込み済みのセッションのイベント（seq 順） */
  events: Record<string, SessionEvent[]>;
  usage: Record<AgentKind, UsageInfo[]>;
  toast: Toast | null;
  /** 表示中の確認ダイアログ */
  confirm: ConfirmRequest | null;
  /** 入力欄に入れてほしい文（巻き戻した発言など）。n は同じ文を続けて入れるときの区別 */
  draft: { sessionId: string; text: string; n: number } | null;
}

/** 画面下の通知。action があれば「元に戻す」などのボタンを添える */
export interface Toast {
  id: number;
  text: string;
  tone: 'error' | 'info';
  action?: { label: string; run: () => void };
}

export interface ConfirmOptions {
  title: string;
  /** 本文（1要素1段落） */
  body: string[];
  confirmLabel: string;
  /** 確定ボタンの文字をエラー色にする（削除など） */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let state: State = {
  connected: false,
  ready: false,
  info: null,
  sessions: {},
  events: {},
  usage: { claude: [], codex: [] },
  toast: null,
  confirm: null,
  draft: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function getState(): State {
  return state;
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

// ---- イベントの読み込み ----

const loading = new Map<string, Promise<void>>();

function lastSeqOf(id: string): number {
  const evs = state.events[id];
  return evs && evs.length ? evs[evs.length - 1].seq : 0;
}

function mergeEvents(id: string, incoming: SessionEvent[]): void {
  if (incoming.length === 0) return;
  set((s) => {
    const cur = s.events[id] ?? [];
    const last = cur.length ? cur[cur.length - 1].seq : 0;
    const add = incoming.filter((e) => e.seq > last);
    if (add.length === 0) return {};
    return { events: { ...s.events, [id]: [...cur, ...add] } };
  });
}

/** セッションのイベントを読み込む（読み込み済みなら差分だけ）。 */
export function loadEvents(id: string): Promise<void> {
  const running = loading.get(id);
  if (running) return running;
  const p = (async () => {
    try {
      const evs = await api.events(id, lastSeqOf(id));
      if (!state.events[id]) set((s) => ({ events: { ...s.events, [id]: [] } }));
      mergeEvents(id, evs);
    } catch (e) {
      // 削除されたセッションは黙って捨てる
      if (state.sessions[id]) showToast(`履歴を読み込めませんでした: ${(e as Error).message}`);
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, p);
  return p;
}

// ---- WebSocket ----

let ws: WebSocket | null = null;
let retry = 0;

// ---- アーカイブ・削除で閉じたセッション ----
// 一覧から外れた（アーカイブした・削除した）セッションを知らせる。ペインを閉じる・詳細画面から戻るのに使う。
// どの端末で操作しても、Hub の配信で全端末に届く。

const closeListeners = new Set<(ids: string[]) => void>();

export function onSessionsClosed(cb: (ids: string[]) => void): () => void {
  closeListeners.add(cb);
  return () => closeListeners.delete(cb);
}

function notifyClosed(ids: string[]): void {
  if (ids.length === 0) return;
  for (const l of closeListeners) l(ids);
}

// ---- AI が作ったセッション ----
// セッションの中の AI が Hub の API で新しいセッションを作ったら（parentSessionId 付きで届いたら）、画面で開く。

const openListeners = new Set<(id: string) => void>();

export function onSessionCreatedByAgent(cb: (id: string) => void): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}

/** セッションを画面で開く（デスクトップは新しいペイン、iPhone は詳細画面）。フォークしたセッションを開くのに使う */
export function openSession(id: string): void {
  for (const l of openListeners) l(id);
}

let draftN = 0;

/** セッションの入力欄に文を入れる（入力中の文は置き換える） */
export function setDraft(sessionId: string, text: string): void {
  set({ draft: { sessionId, text, n: ++draftN } });
}

/** 入力欄が文を受け取ったら消す（開き直したときに、もう一度入れないため） */
export function clearDraft(n: number): void {
  if (state.draft?.n === n) set({ draft: null });
}

/**
 * 画面から外した（ペインを閉じた・別のセッションに切り替えた・詳細画面から戻った）セッションが空なら、Hub に消してもらう。
 * 何も書き込まれていない「新しいセッション」を残さないため。
 */
export function discardIfEmpty(ids: Iterable<string>): void {
  for (const id of ids) {
    if (state.sessions[id]?.empty) api.discard(id).catch(() => {});
  }
}

function onMessage(m: ServerMessage): void {
  switch (m.type) {
    case 'hello': {
      const sessions: Record<string, SessionSummary> = {};
      for (const s of m.sessions) sessions[s.id] = s;
      // 再接続時: 切れている間にアーカイブ・削除されたセッションも閉じる
      const closed = state.ready
        ? Object.values(state.sessions)
            .filter((s) => !s.archived && (!sessions[s.id] || sessions[s.id].archived))
            .map((s) => s.id)
        : [];
      const events = { ...state.events };
      for (const id of Object.keys(events)) if (!sessions[id]) delete events[id];
      set({ sessions, events, info: m.info, usage: m.info.usage, connected: true, ready: true });
      notifyClosed(closed);
      // 再接続時: 読み込み済みのセッションは差分を取り直す
      for (const id of Object.keys(state.events)) void loadEvents(id);
      break;
    }
    case 'session': {
      const prev = state.sessions[m.session.id];
      set((s) => ({ sessions: { ...s.sessions, [m.session.id]: m.session } }));
      if (prev && !prev.archived && m.session.archived) notifyClosed([m.session.id]);
      if (!prev && m.session.parentSessionId && !m.session.archived) for (const l of openListeners) l(m.session.id);
      break;
    }
    case 'session_removed': {
      const id = m.sessionId;
      if (!state.sessions[id] && !state.events[id]) break;
      set((s) => {
        const sessions = { ...s.sessions };
        const events = { ...s.events };
        delete sessions[id];
        delete events[id];
        return { sessions, events };
      });
      notifyClosed([id]);
      break;
    }
    case 'event': {
      const id = m.event.sessionId;
      const cur = state.events[id];
      if (!cur) break; // 読み込んでいないセッションのイベントは捨てる（開いたときに取得する）
      const last = cur.length ? cur[cur.length - 1].seq : 0;
      if (m.event.seq === last + 1) mergeEvents(id, [m.event]);
      else if (m.event.seq > last + 1) void loadEvents(id); // 抜けがあれば取り直す
      break;
    }
    case 'usage':
      set((s) => ({ usage: { ...s.usage, [m.agent]: m.usage } }));
      break;
    case 'info': {
      // 許可待ちのユーザーが増えたら知らせる（許可は設定タブの「アクセス」から）
      const before = new Set(state.info?.access?.pending.map((p) => p.login.toLowerCase()) ?? []);
      const added = m.info.access?.pending.find((p) => !before.has(p.login.toLowerCase()));
      set({ info: m.info });
      if (added) showInfo(`${added.login} がアクセスを求めています（設定 → アクセス で許可できます）`);
      break;
    }
  }
}

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
  };
  sock.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    } catch {
      /* 壊れたメッセージは無視 */
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    set({ connected: false });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

// iOS でアプリに戻ってきたとき、切れていればすぐつなぎ直す
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState === WebSocket.CLOSED)) {
      retry = 0;
      connect();
    }
  });
}

// ---- 通知 ----

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastId = 0;

function putToast(t: Omit<Toast, 'id'>, ms: number): void {
  const id = ++toastId;
  set({ toast: { ...t, id } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast?.id === id) set({ toast: null });
  }, ms);
}

/** 失敗などの知らせ（エラー色の枠） */
export function showToast(msg: string): void {
  putToast({ text: msg, tone: 'error' }, 5000);
}

/** 操作が済んだことの知らせ（数秒で消える） */
export function showInfo(msg: string): void {
  putToast({ text: msg, tone: 'info' }, 4000);
}

/** 「元に戻す」付きの知らせ（数秒で消える） */
export function showUndo(text: string, undo: () => void): void {
  putToast({ text, tone: 'info', action: { label: '元に戻す', run: undo } }, 6000);
}

export function dismissToast(): void {
  set({ toast: null });
}

// ---- 確認ダイアログ ----

/** 確認ダイアログを出し、確定なら true を返す（表示は ConfirmHost） */
export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  state.confirm?.resolve(false);
  return new Promise((resolve) => {
    set({
      confirm: {
        ...opts,
        resolve: (ok) => {
          set({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}

/**
 * 登録済みのプロジェクト（フォルダと AI の組）を、folders の to 番目へ動かす。全端末で共有する（Hub が設定ファイルの順を入れ替える）。
 * 画面にはすぐ反映し、Hub が断ったら元に戻す。
 */
export async function moveProject(project: { path: string; agent: AgentKind }, to: number): Promise<void> {
  const info = state.info;
  if (!info) return;
  const from = info.folders.findIndex((f) => f.path === project.path && f.agent === project.agent);
  const target = Math.max(0, Math.min(to, info.folders.length - 1));
  if (from < 0 || from === target) return;
  const folders = [...info.folders];
  const [moved] = folders.splice(from, 1);
  folders.splice(target, 0, moved);
  set({ info: { ...info, folders } });
  try {
    await api.reorderProjects({ projects: folders.map((f) => ({ path: f.path, agent: f.agent })) });
  } catch (e) {
    // その間に Hub から新しい info が届いていれば、そちらを残す
    if (state.info?.folders === folders) set({ info: { ...state.info, folders: info.folders } });
    showToast((e as Error).message);
  }
}

/** プロジェクト（フォルダと AI の組）の色を変える（null で外す）。全端末で共有する。画面にはすぐ反映し、Hub が断ったら元に戻す */
export async function setProjectColor(project: { path: string; agent: AgentKind }, color: ProjectColor | null): Promise<void> {
  const { path, agent } = project;
  const info = state.info;
  if (!info) return;
  const folders = info.folders.map((f) => {
    if (f.path !== path || f.agent !== agent) return f;
    const { color: _old, ...rest } = f;
    return color ? { ...rest, color } : rest;
  });
  set({ info: { ...info, folders } });
  try {
    await api.updateProject({ path, agent, color });
  } catch (e) {
    if (state.info?.folders === folders) set({ info: { ...state.info, folders: info.folders } });
    showToast((e as Error).message);
  }
}

/** アクセスの許可・取り消し・許可待ちから外す。Hub の応答（新しい一覧）をすぐ画面に反映する */
export async function changeAccess(kind: 'allow' | 'revoke' | 'dismiss', login: string): Promise<void> {
  const call = kind === 'allow' ? api.allowUser : kind === 'revoke' ? api.revokeUser : api.dismissUser;
  const access = await run(() => call(login));
  if (access && state.info) set({ info: { ...state.info, access } });
}

/** 操作を実行し、失敗したら通知を出す。 */
export async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    showToast((e as Error).message);
    return undefined;
  }
}

/** 一覧で使う: エージェントごとの並べ替え済みセッション（Hub と同じ規則で並べる。ピン止めが先頭、その中と残りは順位の順）。 */
export function sortedSessions(sessions: Record<string, SessionSummary>, agent?: AgentKind, includeArchived = false): SessionSummary[] {
  return Object.values(sessions)
    .filter((s) => (!agent || s.agent === agent) && (includeArchived || !s.archived))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank === 5) return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      return a.statusSince.localeCompare(b.statusSince) || a.id.localeCompare(b.id);
    });
}

/**
 * 確認待ちか: 許可・質問のカードが実際に出ている（未解決の依頼がある）セッション。
 * 状態（waiting_*）だけでは判断しない。カードが出ていないのに待ちに見えるのを防ぐため。
 */
export function needsAnswer(s: SessionSummary | undefined): boolean {
  return !!s && !s.archived && (s.pendingApprovals.length > 0 || s.pendingQuestions.length > 0);
}

/** 未読か（確認待ちも含む）: 一覧の「あなたの番」と同じ範囲 */
export function isUnreadOrWaiting(s: SessionSummary): boolean {
  return !s.archived && s.rank <= 3;
}

/** 「あなたの番」（許可待ち・質問・完了未読）の件数 */
export function waitingCount(sessions: Record<string, SessionSummary>, agent?: AgentKind): number {
  return Object.values(sessions).filter((s) => !s.archived && s.rank <= 3 && (!agent || s.agent === agent)).length;
}

// アプリアイコンのバッジ（対応している環境だけ）
let lastBadge = -1;
listeners.add(() => {
  const n = waitingCount(state.sessions);
  if (n === lastBadge) return;
  lastBadge = n;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (n > 0) nav.setAppBadge?.(n).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
  document.title = n > 0 ? `(${n}) AgentPWA` : 'AgentPWA';
});
