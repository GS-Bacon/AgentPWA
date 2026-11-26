// ペインをドラッグしている間の状態（どのペインを、どのペインのどこに落とそうとしているか）。
// 落とす先のペインだけでなく、掴んだペインの側にも「落とすとどうなるか」を出すために、ペインどうしで共有する。
// （VS Code のエディターグループのドラッグを参考にしている。docs/architecture.md の「ペインの並べ方」）

import { useSyncExternalStore } from 'react';
import type { DropZone } from '../lib/layout.ts';

export interface PaneDrag {
  /** 掴んでいるペイン */
  source: string;
  /** いま上にあるペイン（ほかのペインの上にないときは null） */
  target: string | null;
  zone: DropZone | null;
}

let current: PaneDrag | null = null;
const listeners = new Set<() => void>();

export function setPaneDrag(next: PaneDrag | null): void {
  if (current === next || (current && next && current.source === next.source && current.target === next.target && current.zone === next.zone)) return;
  current = next;
  for (const f of listeners) f();
}

export function getPaneDrag(): PaneDrag | null {
  return current;
}

export function usePaneDrag(): PaneDrag | null {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => current,
  );
}

// ドラッグを取りやめたときや、ペインの外に落としたときにも消す
if (typeof document !== 'undefined') {
  const clear = () => setPaneDrag(null);
  document.addEventListener('dragend', clear);
  document.addEventListener('drop', clear);
}
