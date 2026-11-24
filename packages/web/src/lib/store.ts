// 画面の状態（セッション一覧・イベント）と Hub との WebSocket 接続。
// useSyncExternalStore で購読する小さなストア。
import { useSyncExternalStore } from 'react';
import type { AgentKind, SessionEvent } from '@agentpwa/shared';
import type { HubInfo, ServerMessage, SessionSummary, UsageInfo } from '@agentpwa/hub/api';
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
  toast: string | null;
}

let state: State = {
  connected: false,
  ready: false,
  info: null,
  sessions: {},
  events: {},
  usage: { claude: [], codex: [] },
  toast: null,
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
      showToast(`履歴を読み込めませんでした: ${(e as Error).message}`);
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

function onMessage(m: ServerMessage): void {
  switch (m.type) {
    case 'hello': {
      const sessions: Record<string, SessionSummary> = {};
      for (const s of m.sessions) sessions[s.id] = s;
      set({ sessions, info: m.info, usage: m.info.usage, connected: true, ready: true });
      // 再接続時: 読み込み済みのセッションは差分を取り直す
      for (const id of Object.keys(state.events)) void loadEvents(id);
      break;
    }
    case 'session':
      set((s) => ({ sessions: { ...s.sessions, [m.session.id]: m.session } }));
      break;
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
    case 'info':
      set({ info: m.info });
      break;
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
export function showToast(msg: string): void {
  set({ toast: msg });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 5000);
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

/** 一覧で使う: エージェントごとの並べ替え済みセッション（Hub と同じ規則で並べる）。 */
export function sortedSessions(sessions: Record<string, SessionSummary>, agent?: AgentKind, includeArchived = false): SessionSummary[] {
  return Object.values(sessions)
    .filter((s) => (!agent || s.agent === agent) && (includeArchived || !s.archived))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank === 5) return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      return a.statusSince.localeCompare(b.statusSince) || a.id.localeCompare(b.id);
    });
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
