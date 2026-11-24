// iPad / Web のペインの並び。端末ごとに localStorage へ自動保存し、次に開いたときに復元する。
// （名前を付けて保存する「ワークスペース」は MVP では作らない）
import { useEffect, useState } from 'react';

export interface Pane {
  id: string;
  sessionId: string | null;
  /** ビュワーのペイン（docs/architecture.md の 5.1）。このときの sessionId は null */
  view?: { sessionId: string; path: string };
}

/** セッションもファイルも表示していないペイン */
export function isEmptyPane(p: Pane): boolean {
  return !p.sessionId && !p.view;
}

/** ペインの並び: 列の並び。各列にペインを縦に積む。weight は相対的な大きさ（VS Code のエディターグループに近い形）。 */
export interface CustomCol {
  id: string;
  weight: number;
  rows: { paneId: string; weight: number }[];
}

export interface LayoutState {
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
      // 以前の保存データにある mode（1列・2列…の切り替え）は使わない
      const { mode: _mode, ...s } = JSON.parse(raw) as LayoutState & { mode?: unknown };
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
  // panes を見た目の順（列を左から、列の中は上から）に並べる。ペインの番号と Alt+1〜9 がこの順になる
  const order = new Map(custom.flatMap((c) => c.rows.map((r) => r.paneId)).map((id, i) => [id, i]));
  const panes = [...s.panes].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const focused = s.focused && ids.has(s.focused) ? s.focused : panes[0]?.id ?? null;
  return { ...s, panes, custom, focused };
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

export function closePane(s: LayoutState, paneId: string): LayoutState {
  let panes = s.panes.filter((p) => p.id !== paneId);
  if (panes.length === 0) panes = [{ id: newId(), sessionId: null }];
  const focused = s.focused === paneId ? panes[Math.max(0, s.panes.findIndex((p) => p.id === paneId) - 1)]?.id ?? panes[0].id : s.focused;
  return { ...s, panes, focused };
}

export function setPaneSession(s: LayoutState, paneId: string, sessionId: string | null): LayoutState {
  return { ...s, panes: s.panes.map((p) => (p.id === paneId ? { id: p.id, sessionId } : p)), focused: paneId };
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
    const empty = s.panes.find(isEmptyPane);
    if (empty) return setPaneSession(s, empty.id, sessionId);
    return addPane(s, sessionId);
  }
  return setPaneSession(s, target.id, sessionId);
}

/** 境界をドラッグしたときの重み調整（i と i+1 の間） */
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

/**
 * ファイルをビュワーのペインで開く。同じセッションのビュワーのペインがあれば中身を差し替える（ペインを増やし続けない）。
 * なければ、そのセッションのペインの右に列を足して置く。フォーカスはビュワーに移す。
 */
export function openViewer(s: LayoutState, sessionId: string, path: string): LayoutState {
  const existing = s.panes.find((p) => p.view?.sessionId === sessionId);
  if (existing) {
    return { ...s, panes: s.panes.map((p) => (p.id === existing.id ? { ...p, view: { sessionId, path } } : p)), focused: existing.id };
  }
  const p: Pane = { id: newId(), sessionId: null, view: { sessionId, path } };
  const src = s.panes.find((x) => x.sessionId === sessionId);
  const custom = src ? insertAt(s.custom, p.id, src.id, 'right') : s.custom;
  return { ...s, panes: [...s.panes, p], custom, focused: p.id };
}

// ---- ドラッグ＆ドロップ（VS Code のエディターグループと同じ操作） ----

/** ドロップ先: ペインの上下左右の端なら分割、中央なら入れ替え（一覧のセッションなら表示） */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** ペインの中の位置から、ドロップ先を決める（端から 25% の範囲を端とみなす） */
export function zoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): DropZone {
  const fx = (x - rect.left) / Math.max(1, rect.width);
  const fy = (y - rect.top) / Math.max(1, rect.height);
  const d = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (d >= 0.25) return 'center';
  if (d === fx) return 'left';
  if (d === 1 - fx) return 'right';
  return d === fy ? 'top' : 'bottom';
}

/** 木からペインを外す（空いた列は消す） */
function detach(custom: CustomCol[], paneId: string): CustomCol[] {
  return custom.map((c) => ({ ...c, rows: c.rows.filter((r) => r.paneId !== paneId) })).filter((c) => c.rows.length > 0);
}

/** 木の中で、target の上下左右にペインを入れる（target の大きさを半分ずつ分ける） */
function insertAt(custom: CustomCol[], paneId: string, targetId: string, zone: Exclude<DropZone, 'center'>): CustomCol[] {
  const ci = custom.findIndex((c) => c.rows.some((r) => r.paneId === targetId));
  if (ci < 0) return [...custom, { id: newId('c'), weight: 1, rows: [{ paneId, weight: 1 }] }];
  const out = [...custom];
  const col = out[ci];
  if (zone === 'left' || zone === 'right') {
    const half = col.weight / 2;
    out[ci] = { ...col, weight: half };
    out.splice(zone === 'left' ? ci : ci + 1, 0, { id: newId('c'), weight: half, rows: [{ paneId, weight: 1 }] });
    return out;
  }
  const ri = col.rows.findIndex((r) => r.paneId === targetId);
  const rows = [...col.rows];
  const half = rows[ri].weight / 2;
  rows[ri] = { ...rows[ri], weight: half };
  rows.splice(zone === 'top' ? ri : ri + 1, 0, { paneId, weight: half });
  out[ci] = { ...col, rows };
  return out;
}

/** ペインを別のペインの上下左右へ動かす。中央なら2枚の位置を入れ替える */
export function movePane(s: LayoutState, paneId: string, targetId: string, zone: DropZone): LayoutState {
  if (paneId === targetId || !s.panes.some((p) => p.id === paneId) || !s.panes.some((p) => p.id === targetId)) return s;
  if (zone === 'center') {
    const swap = (id: string) => (id === paneId ? targetId : id === targetId ? paneId : id);
    const custom = s.custom.map((c) => ({ ...c, rows: c.rows.map((r) => ({ ...r, paneId: swap(r.paneId) })) }));
    return { ...s, custom, focused: paneId };
  }
  return { ...s, custom: insertAt(detach(s.custom, paneId), paneId, targetId, zone), focused: paneId };
}

/**
 * 一覧からセッションをペインへ落とす。中央ならそのペインに表示し（別のペインに出ていたら、そちらは空にする）、
 * 端なら、そのセッションのペインをその位置に置く（すでに別のペインに出ていれば、そのペインを動かす）。
 */
export function dropSession(s: LayoutState, sessionId: string, targetId: string, zone: DropZone): LayoutState {
  const existing = s.panes.find((p) => p.sessionId === sessionId);
  if (zone === 'center') {
    if (existing?.id === targetId) return { ...s, focused: targetId };
    const cleared = { ...s, panes: s.panes.map((p) => (p.sessionId === sessionId ? { ...p, sessionId: null } : p)) };
    return setPaneSession(cleared, targetId, sessionId);
  }
  if (existing) return movePane(s, existing.id, targetId, zone);
  const p: Pane = { id: newId(), sessionId };
  return { ...s, panes: [...s.panes, p], custom: insertAt(s.custom, p.id, targetId, zone), focused: p.id };
}

/** 列の幅をそろえる（列の境界のダブルクリック） */
export function equalizeCols(s: LayoutState): LayoutState {
  return { ...s, custom: s.custom.map((c) => ({ ...c, weight: 1 })) };
}

/** 列の中のペインの高さをそろえる（行の境界のダブルクリック） */
export function equalizeRows(s: LayoutState, colId: string): LayoutState {
  return { ...s, custom: s.custom.map((c) => (c.id === colId ? { ...c, rows: c.rows.map((r) => ({ ...r, weight: 1 })) } : c)) };
}
