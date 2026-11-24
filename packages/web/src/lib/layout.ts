// iPad / Web のペインの並び。端末ごとに localStorage へ自動保存し、次に開いたときに復元する。
// （名前を付けて保存する「ワークスペース」は MVP では作らない）
import { useEffect, useState } from 'react';

export type LayoutMode = 'cols1' | 'cols2' | 'cols3' | 'grid4' | 'custom';

export interface Pane {
  id: string;
  sessionId: string | null;
}

/** 自由分割（Web）: 列の並び。各列にペインを縦に積む。weight は相対的な大きさ。 */
export interface CustomCol {
  id: string;
  weight: number;
  rows: { paneId: string; weight: number }[];
}

export interface LayoutState {
  mode: LayoutMode;
  panes: Pane[];
  focused: string | null;
  custom: CustomCol[];
  /** サイドバーを広げて表示するか */
  sidebarOpen: boolean;
  /** 一覧で畳んでいるプロジェクト（projectKey） */
  collapsed: string[];
}

const KEY = 'agentpwa.layout.v1';

let counter = 0;
export function newId(prefix = 'p'): string {
  return `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
}

function initial(): LayoutState {
  const p: Pane = { id: newId(), sessionId: null };
  const wide = typeof window !== 'undefined' && window.innerWidth >= 1100;
  return {
    mode: wide ? 'cols3' : 'cols2',
    panes: [p],
    focused: p.id,
    custom: [{ id: newId('c'), weight: 1, rows: [{ paneId: p.id, weight: 1 }] }],
    sidebarOpen: wide,
    collapsed: [],
  };
}

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as LayoutState;
      if (Array.isArray(s.panes) && s.panes.length > 0) return syncCustom({ ...s, collapsed: Array.isArray(s.collapsed) ? s.collapsed : [] });
    }
  } catch {
    /* 読めなければ初期状態 */
  }
  return initial();
}

/** custom の木を panes に合わせる（無いペインは右に列を足し、消えたペインは取り除く）。 */
export function syncCustom(s: LayoutState): LayoutState {
  const ids = new Set(s.panes.map((p) => p.id));
  let custom = (s.custom ?? [])
    .map((c) => ({ ...c, rows: c.rows.filter((r) => ids.has(r.paneId)) }))
    .filter((c) => c.rows.length > 0);
  const placed = new Set(custom.flatMap((c) => c.rows.map((r) => r.paneId)));
  for (const p of s.panes) {
    if (!placed.has(p.id)) custom = [...custom, { id: newId('c'), weight: 1, rows: [{ paneId: p.id, weight: 1 }] }];
  }
  const focused = s.focused && ids.has(s.focused) ? s.focused : s.panes[0]?.id ?? null;
  return { ...s, custom, focused };
}

export function useLayout(): [LayoutState, (fn: (s: LayoutState) => LayoutState) => void] {
  const [state, setState] = useState<LayoutState>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* 保存できなくても動作は続ける */
    }
  }, [state]);
  return [state, (fn) => setState((s) => syncCustom(fn(s)))];
}

export function resetLayout(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

// ---- 操作（純粋関数） ----

export function addPane(s: LayoutState, sessionId: string | null = null): LayoutState {
  const p: Pane = { id: newId(), sessionId };
  return { ...s, panes: [...s.panes, p], focused: p.id };
}

/** 自由分割で、指定したペインの下に新しいペインを足す */
export function splitBelow(s: LayoutState, paneId: string): LayoutState {
  const p: Pane = { id: newId(), sessionId: null };
  const custom = s.custom.map((c) => {
    const i = c.rows.findIndex((r) => r.paneId === paneId);
    if (i < 0) return c;
    const rows = [...c.rows];
    const half = rows[i].weight / 2;
    rows[i] = { ...rows[i], weight: half };
    rows.splice(i + 1, 0, { paneId: p.id, weight: half });
    return { ...c, rows };
  });
  return { ...s, panes: [...s.panes, p], custom, focused: p.id };
}

/** 自由分割で、指定したペインの列の右に新しい列を足す */
export function splitRight(s: LayoutState, paneId: string): LayoutState {
  const p: Pane = { id: newId(), sessionId: null };
  const ci = s.custom.findIndex((c) => c.rows.some((r) => r.paneId === paneId));
  const custom = [...s.custom];
  const half = (custom[ci]?.weight ?? 1) / 2;
  if (ci >= 0) custom[ci] = { ...custom[ci], weight: half };
  custom.splice(ci + 1, 0, { id: newId('c'), weight: half || 1, rows: [{ paneId: p.id, weight: 1 }] });
  return { ...s, panes: [...s.panes, p], custom, focused: p.id };
}

export function closePane(s: LayoutState, paneId: string): LayoutState {
  let panes = s.panes.filter((p) => p.id !== paneId);
  if (panes.length === 0) panes = [{ id: newId(), sessionId: null }];
  const focused = s.focused === paneId ? panes[Math.max(0, s.panes.findIndex((p) => p.id === paneId) - 1)]?.id ?? panes[0].id : s.focused;
  return { ...s, panes, focused };
}

export function setPaneSession(s: LayoutState, paneId: string, sessionId: string | null): LayoutState {
  return { ...s, panes: s.panes.map((p) => (p.id === paneId ? { ...p, sessionId } : p)), focused: paneId };
}

/**
 * セッションを開く: 既にどこかのペインにあればそこへ移る。
 * なければフォーカス中のペインに表示する（フォーカス中のペインが返答待ちを表示中なら、新しいペインを足す）。
 */
export function openSession(s: LayoutState, sessionId: string, isWaiting: (sessionId: string) => boolean): LayoutState {
  const existing = s.panes.find((p) => p.sessionId === sessionId);
  if (existing) return { ...s, focused: existing.id };
  const target = s.panes.find((p) => p.id === s.focused) ?? s.panes[0];
  if (target.sessionId && isWaiting(target.sessionId)) {
    const empty = s.panes.find((p) => !p.sessionId);
    if (empty) return setPaneSession(s, empty.id, sessionId);
    return addPane(s, sessionId);
  }
  return setPaneSession(s, target.id, sessionId);
}

/** 自由分割の境界をドラッグしたときの重み調整（i と i+1 の間） */
export function resizeWeights<T extends { weight: number }>(items: T[], i: number, deltaFrac: number): T[] {
  const a = items[i];
  const b = items[i + 1];
  if (!a || !b) return items;
  const total = a.weight + b.weight;
  const sum = items.reduce((n, x) => n + x.weight, 0);
  const d = deltaFrac * sum;
  const min = total * 0.12;
  const na = Math.min(total - min, Math.max(min, a.weight + d));
  const out = [...items];
  out[i] = { ...a, weight: na };
  out[i + 1] = { ...b, weight: total - na };
  return out;
}
