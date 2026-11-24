// iPad / Web: 左の一覧と、何枚でも並べられるペイン。
// 並べ方は VS Code のエディターグループと同じ操作: ペインの見出しをドラッグして、ほかのペインの上下左右の端に落とすと分割、
// 中央に落とすと入れ替え。境界をドラッグして大きさを変え、境界のダブルクリックで均等にする。
// 画面に収まらないときは横スクロール（iPad は横スワイプ）で表示する。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { discardIfEmpty, getState, onSessionCreatedByAgent, onSessionsClosed, run, sortedSessions, useStore } from '../lib/store.ts';
import { isRunning } from '../lib/format.ts';
import type { ArchiveSectionProps } from '../App.tsx';
import { DRAG_TYPE, isWaiting, Rail, Sidebar } from './Sidebar.tsx';
import {
  addPane,
  closePane,
  dropSession,
  equalizeCols,
  equalizeRows,
  isEmptyPane,
  movePane,
  openSession,
  openSessionInNewPane,
  openViewer,
  resizeWeights,
  setPaneSession,
  useLayout,
  zoneAt,
  type DropZone,
  type LayoutState,
  type Pane,
} from '../lib/layout.ts';
import { decide, useNow } from '../components/Requests.tsx';
import { AutoWarn, ConnState, SessionMenu, StatusLabel } from '../components/common.tsx';
import { SessionView } from '../components/SessionView.tsx';
import { NewSessionForm } from '../components/NewSession.tsx';
import { Settings } from '../components/Settings.tsx';
import { FileViewer } from '../components/FileViewer.tsx';
import { onOpenFile } from '../lib/viewer.ts';
import { AgentIcon, IconClose, IconMaximize, IconSidebar } from '../components/Icons.tsx';

/** ペインを動かすドラッグのデータの種類 */
const PANE_DRAG_TYPE = 'application/x-agentpwa-pane';
/** ドラッグ中のペイン（dragover の間は dataTransfer の中身を読めないため、ここに持つ） */
let draggingPane: string | null = null;

/** ドロップ先の重ね表示の位置 */
// 分割後のペインの形が分かるように、ペインの縁から少し内側に、新しいペインが入る半分を四角で示す
const G = 4;
const HALF = `calc(50% - ${G * 1.5}px)`;
const ZONE_STYLE: Record<DropZone, React.CSSProperties> = {
  left: { left: G, top: G, bottom: G, width: HALF },
  right: { right: G, top: G, bottom: G, width: HALF },
  top: { left: G, right: G, top: G, height: HALF },
  bottom: { left: G, right: G, bottom: G, height: HALF },
  center: { inset: G },
};
/** 分割したときに、元のペインが残る側（新しいペインの反対側） */
const REST_ZONE: Record<Exclude<DropZone, 'center'>, DropZone> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const ZONE_LABEL: Record<Exclude<DropZone, 'center'>, string> = { left: '左に分割', right: '右に分割', top: '上に分割', bottom: '下に分割' };

// ドラッグ中は、ビュワーの iframe などがドラッグを横取りしないように、body に印を付ける（styles.css の body.dragging）
if (typeof document !== 'undefined') {
  const on = () => document.body.classList.add('dragging');
  const off = () => document.body.classList.remove('dragging');
  document.addEventListener('dragstart', on);
  document.addEventListener('dragend', off);
  document.addEventListener('drop', off);
  // 掴んだ要素が移動して dragend が届かなかったときの保険（ドラッグ中は mousemove が来ない）
  document.addEventListener('mousemove', off);
}

// ---- ペイン ----

/** ペインが表示しているセッション（ビュワーのペインは、開いたファイルのセッション） */
function paneSession(p: Pane): string | null {
  return p.sessionId ?? p.view?.sessionId ?? null;
}

function PaneView({
  pane,
  index,
  layout,
  update,
  maximized,
  setMaximized,
}: {
  pane: Pane;
  index: number;
  layout: LayoutState;
  update: (fn: (s: LayoutState) => LayoutState) => void;
  maximized: boolean;
  setMaximized: (id: string | null) => void;
}) {
  const s = useStore((st) => (pane.sessionId ? st.sessions[pane.sessionId] : undefined));
  const sessions = useStore((st) => st.sessions);
  const now = useNow();
  const [zone, setZone] = useState<DropZone | null>(null);
  const [dragKind, setDragKind] = useState<'pane' | 'session'>('pane');
  // ドラッグを取りやめたときや、ほかの場所に落としたときに、重ね表示を消す
  useEffect(() => {
    if (!zone) return;
    const clear = () => setZone(null);
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
    };
  }, [zone]);
  const focused = layout.focused === pane.id;
  const waiting = s && s.rank <= 2;

  // 見出しをドラッグしてペインを動かす
  const onHeadDragStart = (e: React.DragEvent) => {
    // 見出しの中のボタンやメニューからのドラッグは扱わない
    if ((e.target as HTMLElement).closest?.('button, [role="menu"]')) {
      e.preventDefault();
      return;
    }
    draggingPane = pane.id;
    e.dataTransfer.setData(PANE_DRAG_TYPE, pane.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onHeadDragEnd = () => {
    draggingPane = null;
  };

  // ペインのドラッグと、一覧からのセッションのドラッグを受け付ける
  const dropTarget = {
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      const isPane = types.includes(PANE_DRAG_TYPE);
      if (!isPane && !types.includes(DRAG_TYPE)) return;
      if (isPane && draggingPane === pane.id) {
        setZone(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = isPane ? 'move' : 'copy';
      const z = zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      if (z !== zone) setZone(z);
      const kind = isPane ? 'pane' : 'session';
      if (kind !== dragKind) setDragKind(kind);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Safari などは relatedTarget が空のことがあるので、ポインターがペインの外に出たかを位置で見る
      // （中の要素をまたぐたびに消えると、重ね表示がちらつく）
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setZone(null);
    },
    onDrop: (e: React.DragEvent) => {
      const z = zone ?? zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      setZone(null);
      const paneId = e.dataTransfer.getData(PANE_DRAG_TYPE);
      const sessionId = e.dataTransfer.getData(DRAG_TYPE);
      if (!paneId && !sessionId) return;
      e.preventDefault();
      setMaximized(null);
      if (paneId) update((l) => movePane(l, paneId, pane.id, z));
      else update((l) => dropSession(l, sessionId, pane.id, z));
    },
  };
  // ドロップすると何が起きるかを、範囲と文字で示す（VS Code と同じく、分割なら新しいペインが入る半分を塗る）
  const dropOverlay = zone && (
    <>
      {zone !== 'center' && <div aria-hidden className="drop-rest" style={ZONE_STYLE[REST_ZONE[zone]]} />}
      <div aria-hidden className="drop-overlay" style={ZONE_STYLE[zone]}>
        <span className="drop-label">{zone === 'center' ? (dragKind === 'pane' ? '入れ替え' : 'このペインに表示') : ZONE_LABEL[zone]}</span>
      </div>
    </>
  );

  const quick = sortedSessions(sessions).filter((x) => !layout.panes.some((p) => p.sessionId === x.id)).slice(0, 6);

  const paneButtons = (
    <>
      <button className="btn btn-ghost btn-icon-sm" aria-label={maximized ? '元に戻す' : '最大化'} title={maximized ? '元に戻す' : '最大化'} onClick={() => setMaximized(maximized ? null : pane.id)}>
        <IconMaximize size={14} />
      </button>
      <button
        className="btn btn-ghost btn-icon-sm"
        aria-label="ペインを閉じる"
        title="ペインを閉じる"
        onClick={() => {
          if (maximized) setMaximized(null);
          update((l) => closePane(l, pane.id));
        }}
      >
        <IconClose size={14} />
      </button>
    </>
  );

  // ビュワーのペイン（docs/architecture.md の 5.1）
  if (pane.view) {
    return (
      <section
        data-pane={pane.id}
        aria-label={`ペイン${index + 1}（ファイル）`}
        tabIndex={-1}
        onMouseDownCapture={() => !focused && update((l) => ({ ...l, focused: pane.id }))}
        onFocusCapture={() => !focused && update((l) => ({ ...l, focused: pane.id }))}
        {...dropTarget}
        onDragEnd={onHeadDragEnd}
        style={{ position: 'relative', minWidth: 0, minHeight: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        <FileViewer
          sessionId={pane.view.sessionId}
          path={pane.view.path}
          lead={<span className="pane-tag" style={focused ? { borderColor: 'var(--link)', color: 'var(--fg)' } : undefined}>{index + 1}</span>}
          trail={paneButtons}
          onHeadDragStart={onHeadDragStart}
        />
        {dropOverlay}
      </section>
    );
  }

  return (
    <section
      data-pane={pane.id}
      aria-label={`ペイン${index + 1}`}
      tabIndex={-1}
      onMouseDownCapture={() => !focused && update((l) => ({ ...l, focused: pane.id }))}
      onFocusCapture={() => !focused && update((l) => ({ ...l, focused: pane.id }))}
      {...dropTarget}
      style={{ position: 'relative', minWidth: 0, minHeight: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <header
        draggable
        onDragStart={onHeadDragStart}
        onDragEnd={onHeadDragEnd}
        title="ドラッグしてペインを移動・分割"
        style={{
          cursor: 'grab',
          flex: 'none', padding: '5px 4px 5px 8px', background: 'var(--bg-muted)', borderTop: `2px solid ${waiting ? 'var(--attention)' : 'transparent'}`,
          borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
        }}
      >
        <span className="pane-tag" style={focused ? { borderColor: 'var(--link)', color: 'var(--fg)' } : undefined}>{index + 1}</span>
        {s ? (
          <>
            <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
              <h2 className="ellipsis" style={{ fontSize: 13.5, fontWeight: 600 }}>{s.title}</h2>
              <span className="ellipsis muted" style={{ fontSize: 11 }}>
                <AgentIcon agent={s.agent} size={12} /> {s.folderName} · {s.machine}
                {s.model ? ` · ${s.model}` : ''}
              </span>
            </div>
            <AutoWarn s={s} />
            <StatusLabel s={s} withTime now={now} />
            <SessionMenu
              s={s}
              extra={[{ label: 'ペインから外す', onClick: () => update((l) => setPaneSession(l, pane.id, null)) }]}
            />
          </>
        ) : (
          <span className="muted" style={{ flex: 1, fontSize: 13 }}>空のペイン</span>
        )}
        {paneButtons}
      </header>
      {s ? (
        <SessionView key={s.id} session={s} focused={focused} />
      ) : (
        <div className="empty" style={{ flex: 1, justifyContent: 'center' }}>
          <span>左の一覧からセッションをドラッグするか、選んで表示します</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 'min(320px, 100%)' }}>
            {quick.map((x) => (
              <button key={x.id} className="btn" style={{ justifyContent: 'space-between' }} onClick={() => update((l) => setPaneSession(l, pane.id, x.id))}>
                <span className="ellipsis">{x.title}</span>
                <StatusLabel s={x} />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** ペインの境界。ドラッグで大きさを変え、ダブルクリックで均等にする */
function Splitter({ dir, onDrag, onReset }: { dir: 'col' | 'row'; onDrag: (deltaPx: number) => void; onReset: () => void }) {
  const start = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      title="ドラッグで大きさを変更 · ダブルクリックで均等"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        start.current = dir === 'col' ? e.clientX : e.clientY;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const pos = dir === 'col' ? e.clientX : e.clientY;
        const d = pos - start.current;
        if (d !== 0) {
          start.current = pos;
          onDrag(d);
        }
      }}
      style={{
        // 掴みやすい 9px のうち、真ん中の 1px だけを線として塗る。全体の box-sizing: border-box のままだと
        // 透明な枠 8px が幅 1px を食いつぶして線が消えるので、ここだけ content-box にする
        flex: 'none', boxSizing: 'content-box', background: 'var(--border)', touchAction: 'none', position: 'relative', zIndex: 2,
        ...(dir === 'col' ? { width: 1, cursor: 'col-resize', margin: '0 -4px', borderLeft: '4px solid transparent', borderRight: '4px solid transparent', backgroundClip: 'padding-box' } : { height: 1, cursor: 'row-resize', margin: '-4px 0', borderTop: '4px solid transparent', borderBottom: '4px solid transparent', backgroundClip: 'padding-box' }),
      }}
    />
  );
}

function CustomPanes({ layout, update, renderPane }: { layout: LayoutState; update: (fn: (s: LayoutState) => LayoutState) => void; renderPane: (p: Pane, i: number) => React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const byId = new Map(layout.panes.map((p, i) => [p.id, { p, i }]));
  return (
    <div ref={box} style={{ flex: '1 1 auto', display: 'flex', minWidth: 0, minHeight: 0, background: 'var(--border)', overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain' }}>
      {layout.custom.map((col, ci) => (
        <div key={col.id} style={{ display: 'contents' }}>
          {ci > 0 && (
            <Splitter
              dir="col"
              onDrag={(d) => {
                const w = box.current?.scrollWidth ?? 1;
                update((l) => ({ ...l, custom: resizeWeights(l.custom, ci - 1, d / w) }));
              }}
              onReset={() => update(equalizeCols)}
            />
          )}
          <div style={{ flex: `${col.weight} 1 0`, minWidth: 160, display: 'flex', flexDirection: 'column', minHeight: 0 }} data-col={col.id}>
            {col.rows.map((r, ri) => {
              const entry = byId.get(r.paneId);
              if (!entry) return null;
              return (
                <div key={r.paneId} style={{ display: 'contents' }}>
                  {ri > 0 && (
                    <Splitter
                      dir="row"
                      onDrag={(d) => {
                        const h = (document.querySelector(`[data-col="${col.id}"]`) as HTMLElement | null)?.clientHeight ?? 1;
                        update((l) => ({ ...l, custom: l.custom.map((c) => (c.id === col.id ? { ...c, rows: resizeWeights(c.rows, ri - 1, d / h) } : c)) }));
                      }}
                      onReset={() => update((l) => equalizeRows(l, col.id))}
                    />
                  )}
                  <div style={{ flex: `${r.weight} 1 0`, minHeight: 120, display: 'flex', flexDirection: 'column' }}>{renderPane(entry.p, entry.i)}</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- 全体 ----

export function DesktopApp({ archivedOpen, setArchivedOpen }: ArchiveSectionProps) {
  const [layout, update] = useLayout();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const sessions = useStore((s) => s.sessions);
  const [newSession, setNewSession] = useState<{ cwd?: string } | null>(null);
  const [settings, setSettings] = useState(false);
  const [maximized, setMaximized] = useState<string | null>(null);
  const isFinePointer = useMemo(() => window.matchMedia('(pointer: fine)').matches, []);

  const waiting = sortedSessions(sessions).filter((s) => s.rank <= 3);

  // アーカイブ・削除されたセッションのペインを閉じる（どの端末で操作しても届く）。並びの自動保存からも外れる
  useEffect(() => {
    const closeFor = (ids: Set<string>) => {
      update((l) => {
        let next = l;
        for (const p of l.panes) if (paneSession(p) && ids.has(paneSession(p) as string)) next = closePane(next, p.id);
        return next;
      });
      setMaximized((m) => (m && layoutRef.current.panes.some((p) => p.id === m && paneSession(p) && ids.has(paneSession(p) as string)) ? null : m));
    };
    // 開いていない間に削除されたセッションのペインも閉じる（そのセッションのビュワーのペインも）
    const known = getState().sessions;
    const missing = layoutRef.current.panes.map(paneSession).filter((id): id is string => !!id && !known[id]);
    if (missing.length) closeFor(new Set(missing));
    return onSessionsClosed((ids) => closeFor(new Set(ids)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI が作ったセッションは、新しいペインで開く
  useEffect(
    () =>
      onSessionCreatedByAgent((id) => {
        setMaximized(null);
        update((l) => openSessionInNewPane(l, id));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ペインから外れたセッション（閉じた・別のセッションに切り替えた）が空なら消す
  const shownRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const shown = new Set(layout.panes.map(paneSession).filter((id): id is string => !!id));
    const prev = shownRef.current;
    shownRef.current = shown;
    if (prev) discardIfEmpty([...prev].filter((id) => !shown.has(id)));
  }, [layout.panes]);

  // 会話の中のパスをタップしたら、ビュワーのペインで開く
  useEffect(
    () =>
      onOpenFile((sessionId, path) => {
        setMaximized(null);
        update((l) => openViewer(l, sessionId, path));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const nextWaiting = useCallback(() => {
    update((l) => {
      const list = sortedSessions(getState().sessions).filter((s) => s.rank <= 3);
      if (list.length === 0) return l;
      const cur = l.panes.find((p) => p.id === l.focused)?.sessionId;
      const idx = list.findIndex((s) => s.id === cur);
      const next = list[(idx + 1) % list.length];
      return openSession(l, next.id, isWaiting);
    });
  }, [update]);

  // フォーカスが移ったペインを画面内に入れる
  useEffect(() => {
    const el = document.querySelector(`[data-pane="${layout.focused}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [layout.focused]);

  // キーボード: Alt+J で次の待ちへ、Alt+1〜9 でペインへ、Enter でフォーカス中ペインの許可、Esc でフォーカス中ペインの中断
  useEffect(() => {
    // メニューやダイアログが開いているときの Esc は、それを閉じるだけにする。
    // 閉じる処理が先に走って DOM から消えることがあるので、押した時点（捕捉フェーズ）で調べておく
    let popupOpen = false;
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') popupOpen = !!document.querySelector('.overlay, [role="menu"], [role="dialog"]');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (popupOpen || e.defaultPrevented) return;
        const p = layout.panes.find((x) => x.id === layout.focused);
        const s = p?.sessionId ? getState().sessions[p.sessionId] : undefined;
        if (s && !s.archived && isRunning(s)) {
          e.preventDefault();
          const id = s.id;
          void run(() => api.action(id, { type: 'interrupt' }));
        }
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyJ') {
        e.preventDefault();
        nextWaiting();
        return;
      }
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const p = layout.panes[Number(e.code.slice(5)) - 1];
        if (p) {
          e.preventDefault();
          update((l) => ({ ...l, focused: p.id }));
        }
        return;
      }
      if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const ae = document.activeElement as HTMLElement | null;
        const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.tagName === 'BUTTON' || ae.isContentEditable);
        if (inField) return;
        const sid = layout.panes.find((p) => p.id === layout.focused)?.sessionId;
        const s = sid ? getState().sessions[sid] : undefined;
        const req = s?.pendingApprovals[0];
        if (s && req) {
          e.preventDefault();
          void decide(s.id, req.requestId, 'allow');
        }
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [layout, nextWaiting, update]);

  const renderPane = (p: Pane, i: number) => <PaneView key={p.id} pane={p} index={i} layout={layout} update={update} maximized={maximized === p.id} setMaximized={setMaximized} />;

  const hint = `${layout.panes.length} ペイン · 見出しをドラッグして移動・分割 · 境界のダブルクリックで均等`;

  const sidebarShown = layout.sidebarOpen;
  const maxPane = maximized ? layout.panes.find((p) => p.id === maximized) : undefined;

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--border)', gap: 1, paddingBottom: 'var(--safe-bottom)' }}>
      <header style={{ flex: 'none', minHeight: 52, padding: 'var(--safe-top) 12px 0 8px', background: 'var(--bg-muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-ghost btn-icon" aria-label={sidebarShown ? '一覧を畳む' : '一覧を広げる'} aria-pressed={sidebarShown} onClick={() => update((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))}>
          <IconSidebar />
        </button>
        <h1 style={{ fontSize: 15, fontWeight: 600 }}>AgentPWA</h1>
        <span className="muted ellipsis" style={{ fontSize: 12, marginLeft: 8 }}>{hint}</span>
        <span style={{ flex: '1 1 auto' }} />
        <ConnState />
        <button className={`btn${waiting.length ? ' btn-attention' : ''}`} onClick={nextWaiting} disabled={waiting.length === 0} title="返答待ちのセッションへ順に移動（Alt+J）">
          次の待ちへ
          {isFinePointer && <kbd>Alt+J</kbd>}
          {waiting.length > 0 && <span className="count">{waiting.length}</span>}
        </button>
        <button className="btn" onClick={() => update((l) => addPane(l))}>
          ＋ ペイン
        </button>
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 1 }}>
        {sidebarShown ? (
          <Sidebar layout={layout} update={update} onNew={(cwd) => {
              // プロジェクトの指定がなければ、フォーカス中のペインのセッションのプロジェクトにする
              const sid = layout.panes.find((p) => p.id === layout.focused)?.sessionId;
              setNewSession({ cwd: cwd ?? (sid ? sessions[sid]?.cwd : undefined) });
            }} archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} onSettings={() => setSettings(true)} />
        ) : (
          <Rail layout={layout} update={update} onSettings={() => setSettings(true)} />
        )}
        <main style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' }}>
          {maxPane ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>{renderPane(maxPane, layout.panes.indexOf(maxPane))}</div>
          ) : (
            <CustomPanes layout={layout} update={update} renderPane={renderPane} />
          )}
        </main>
      </div>
      {newSession && (
        <NewSessionForm
          cwd={newSession.cwd}
          onClose={() => setNewSession(null)}
          onCreated={(s) => {
            setNewSession(null);
            update((l) => {
              const target = l.panes.find((p) => p.id === l.focused);
              return target && isEmptyPane(target) ? setPaneSession(l, target.id, s.id) : addPane(l, s.id);
            });
          }}
        />
      )}
      {settings && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setSettings(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="設定" style={{ width: 'min(640px, 100%)' }}>
            <div className="dialog-head">
              <h2>設定</h2>
              <button className="btn btn-ghost btn-icon" aria-label="閉じる" onClick={() => setSettings(false)}>
                <IconClose size={18} />
              </button>
            </div>
            <div className="dialog-body">
              <Settings />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
