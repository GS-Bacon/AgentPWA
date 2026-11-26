// ペインを分割・移動したときの動き（docs/proposals/pane-animation.html の案A）。
// ドロップしたときの青い枠（.drop-overlay）を、ペインの新しい位置まで飛ばし、着いたペインの縁を一瞬光らせる。
// 並び自体はすぐ切り替える。動くのは中身のない枠だけなので、会話が長いペインでも重くならない。

import type { LayoutState } from '../lib/layout.ts';

/** 並びが変わった後に、着地を見せるペイン */
type Landing = {
  /** 並びが変わった後の状態から、着地したペインを探す（新しく作られるペインは、ドロップの時点では id が分からないため） */
  find: (l: LayoutState) => string | undefined;
  /** 枠を飛ばし始める位置。null なら縁を光らせるだけ */
  from: DOMRect | null;
  at: number;
};

let pending: Landing[] = [];

const DURATION = 200;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** 並びが変わらなかった（何もしない操作だった）ときに、古い予約が後の操作で動かないようにする */
const STALE_MS = 1000;

function paneEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(id)}"]`);
}

/** いま画面に出ているペインの位置（最大化中で隠れていれば null） */
export function paneRect(id: string): DOMRect | null {
  return paneEl(id)?.getBoundingClientRect() ?? null;
}

/** 次に並びが変わったときに、着地の動きを見せるよう予約する */
export function expectLanding(find: Landing['find'], from: DOMRect | null): void {
  pending.push({ find, from, at: performance.now() });
}

/** 並びが変わった後（useLayoutEffect）に呼ぶ。予約された着地の動きを再生する */
export function playLandings(layout: LayoutState): void {
  if (pending.length === 0) return;
  const list = pending;
  pending = [];
  const now = performance.now();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const x of list) {
    if (now - x.at > STALE_MS) continue;
    const id = x.find(layout);
    const el = id ? paneEl(id) : null;
    if (!id || !el) continue;
    const to = el.getBoundingClientRect();
    // 視差効果を減らす設定のときや、位置が変わらないときは、縁を光らせるだけにする
    if (reduce || !x.from || near(x.from, to)) {
      flash(el);
      continue;
    }
    void fly(x.from, to).then(() => {
      // 飛んでいる間に作り直されていることがあるので、もう一度探す
      const landed = paneEl(id);
      if (landed) flash(landed);
    });
  }
}

function near(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2 && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;
}

const box = (r: DOMRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** 枠を from から to まで動かし、着いたら消す。枠の太さが変わらないように、拡大縮小ではなく位置と大きさを動かす */
function fly(from: DOMRect, to: DOMRect): Promise<void> {
  const g = document.createElement('div');
  g.className = 'pane-ghost';
  g.setAttribute('aria-hidden', 'true');
  Object.assign(g.style, box(to));
  document.body.appendChild(g);
  const a = g.animate(
    [
      { ...box(from), opacity: 1 },
      { ...box(to), opacity: 1, offset: 0.8 },
      { ...box(to), opacity: 0 },
    ],
    { duration: DURATION * 1.25, easing: EASE },
  );
  return a.finished.then(
    () => g.remove(),
    () => g.remove(),
  );
}

/** ペインの縁を光らせて、ゆっくり消す */
function flash(el: HTMLElement): void {
  const f = document.createElement('div');
  f.className = 'pane-flash';
  f.setAttribute('aria-hidden', 'true');
  el.appendChild(f);
  f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DURATION * 3, easing: 'ease-out' }).finished.then(
    () => f.remove(),
    () => f.remove(),
  );
}
