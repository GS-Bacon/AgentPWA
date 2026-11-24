// iPad / Web: 左の一覧と、何枚でも並べられるペイン。
// レイアウトは 1列・2列・3列・2×2 と、境界をドラッグして自由に分割する「カスタム」。
// 画面に収まらないペインは横スクロール（iPad は横スワイプ）で表示する。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@agentpwa/hub/api';
import { getState, sortedSessions, useStore } from '../lib/store.ts';
import { DRAG_TYPE, isWaiting, Rail, Sidebar } from './Sidebar.tsx';
import { MODE_LABEL } from '../lib/format.ts';
import {
  addPane,
  closePane,
  openSession,
  resizeWeights,
  setPaneSession,
  splitBelow,
  splitRight,
  useLayout,
  type LayoutMode,
  type LayoutState,
  type Pane,
} from '../lib/layout.ts';
import { decide, useNow } from '../components/Requests.tsx';
import { ConnState, SessionMenu, StatusLabel } from '../components/common.tsx';
import { SessionView } from '../components/SessionView.tsx';
import { NewSessionForm } from '../components/NewSession.tsx';
import { Settings } from '../components/Settings.tsx';
import { AgentIcon, IconClose, IconMaximize, IconSidebar, IconSplitDown, IconSplitRight, LayoutIcons } from '../components/Icons.tsx';

const MODES: { mode: LayoutMode; label: string }[] = [
  { mode: 'cols1', label: '1列' },
  { mode: 'cols2', label: '2列' },
  { mode: 'cols3', label: '3列' },
  { mode: 'grid4', label: '2×2' },
  { mode: 'custom', label: 'カスタム（境界をドラッグして分割）' },
];
const COLS: Record<Exclude<LayoutMode, 'custom'>, { cols: number; rows: number }> = {
  cols1: { cols: 1, rows: 1 },
  cols2: { cols: 2, rows: 1 },
  cols3: { cols: 3, rows: 1 },
  grid4: { cols: 2, rows: 2 },
};

// ---- ペイン ----

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
  const [dragOver, setDragOver] = useState(false);
  const focused = layout.focused === pane.id;
  const waiting = s && s.rank <= 2;

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setDragOver(false);
    if (!id) return;
    e.preventDefault();
    update((l) => {
      // 別のペインに出ていたら、そちらは空にする（同じセッションを2枚に出さない）
      const cleared = { ...l, panes: l.panes.map((p) => (p.sessionId === id && p.id !== pane.id ? { ...p, sessionId: null } : p)) };
      return setPaneSession(cleared, pane.id, id);
    });
  };

  const quick = sortedSessions(sessions).filter((x) => !layout.panes.some((p) => p.sessionId === x.id)).slice(0, 6);

  return (
    <section
      data-pane={pane.id}
      aria-label={`ペイン${index + 1}`}
      tabIndex={-1}
      onMouseDownCapture={() => !focused && update((l) => ({ ...l, focused: pane.id }))}
      onFocusCapture={() => !focused && update((l) => ({ ...l, focused: pane.id }))}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{ minWidth: 0, minHeight: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', outline: dragOver ? '2px dashed var(--link)' : undefined, outlineOffset: -2, scrollSnapAlign: 'start', height: '100%' }}
    >
      <header
        style={{
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
                {s.model ? ` · ${s.model}` : ''} · {MODE_LABEL[s.permissionMode]}
              </span>
            </div>
            <StatusLabel s={s} withTime now={now} />
            <SessionMenu
              s={s}
              extra={[{ label: 'ペインから外す', onClick: () => update((l) => setPaneSession(l, pane.id, null)) }]}
            />
          </>
        ) : (
          <span className="muted" style={{ flex: 1, fontSize: 13 }}>空のペイン</span>
        )}
        {layout.mode === 'custom' && (
          <>
            <button className="btn btn-ghost btn-icon-sm" aria-label="右に分割" title="右に分割" onClick={() => update((l) => splitRight(l, pane.id))}>
              <IconSplitRight size={14} />
            </button>
            <button className="btn btn-ghost btn-icon-sm" aria-label="下に分割" title="下に分割" onClick={() => update((l) => splitBelow(l, pane.id))}>
              <IconSplitDown size={14} />
            </button>
          </>
        )}
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

/** 自由分割の境界 */
function Splitter({ dir, onDrag }: { dir: 'col' | 'row'; onDrag: (deltaPx: number) => void }) {
  const start = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
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
        flex: 'none', background: 'var(--border)', touchAction: 'none', position: 'relative', zIndex: 2,
        ...(dir === 'col' ? { width: 1, cursor: 'col-resize', margin: '0 -4px', borderLeft: '4px solid transparent', borderRight: '4px solid transparent', backgroundClip: 'padding-box' } : { height: 1, cursor: 'row-resize', margin: '-4px 0', borderTop: '4px solid transparent', borderBottom: '4px solid transparent', backgroundClip: 'padding-box' }),
      }}
    />
  );
}

function CustomPanes({ layout, update, renderPane }: { layout: LayoutState; update: (fn: (s: LayoutState) => LayoutState) => void; renderPane: (p: Pane, i: number) => React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const byId = new Map(layout.panes.map((p, i) => [p.id, { p, i }]));
  return (
    <div ref={box} style={{ flex: '1 1 auto', display: 'flex', minWidth: 0, minHeight: 0, background: 'var(--border)' }}>
      {layout.custom.map((col, ci) => (
        <div key={col.id} style={{ display: 'contents' }}>
          {ci > 0 && (
            <Splitter
              dir="col"
              onDrag={(d) => {
                const w = box.current?.clientWidth ?? 1;
                update((l) => ({ ...l, custom: resizeWeights(l.custom, ci - 1, d / w) }));
              }}
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

function GridPanes({ layout, renderPane }: { layout: LayoutState; renderPane: (p: Pane, i: number) => React.ReactNode }) {
  const base = COLS[layout.mode as Exclude<LayoutMode, 'custom'>];
  const n = layout.panes.length;
  // ペインが列より少ないときは、空きを作らずに幅いっぱいに広げる
  const rows = n <= base.cols ? 1 : base.rows;
  const cols = Math.max(1, Math.min(base.cols, rows === 1 ? n : base.cols));
  const perPage = cols * rows;
  return (
    <div
      style={{
        flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'grid', gap: 1, background: 'var(--border)',
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, gridAutoColumns: `calc((100% - ${cols - 1}px) / ${cols})`,
        overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain',
      }}
    >
      {layout.panes.map((p, i) => {
        const page = Math.floor(i / perPage);
        const within = i % perPage;
        return (
          <div key={p.id} style={{ gridRow: Math.floor(within / cols) + 1, gridColumn: page * cols + (within % cols) + 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {renderPane(p, i)}
          </div>
        );
      })}
    </div>
  );
}

// ---- 全体 ----

export function DesktopApp({ showArchived, setShowArchived }: { showArchived: boolean; setShowArchived: (v: boolean) => void }) {
  const [layout, update] = useLayout();
  const sessions = useStore((s) => s.sessions);
  const [newSession, setNewSession] = useState<{ cwd?: string } | null>(null);
  const [settings, setSettings] = useState(false);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 1100);
  const isFinePointer = useMemo(() => window.matchMedia('(pointer: fine)').matches, []);

  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 1100);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const waiting = sortedSessions(sessions).filter((s) => s.rank <= 3);

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

  // キーボード: Alt+J で次の待ちへ、Alt+1〜9 でペインへ、Enter でフォーカス中ペインの許可
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout, nextWaiting, update]);

  const renderPane = (p: Pane, i: number) => <PaneView key={p.id} pane={p} index={i} layout={layout} update={update} maximized={maximized === p.id} setMaximized={setMaximized} />;

  const visibleCount = layout.mode === 'custom' ? layout.panes.length : Math.min(layout.panes.length, COLS[layout.mode].cols * COLS[layout.mode].rows);
  const hint =
    layout.mode === 'custom'
      ? '境界をドラッグして調整 · 左の一覧からドラッグして配置'
      : layout.panes.length > visibleCount
        ? `${visibleCount} / ${layout.panes.length} ペイン表示 · ${isFinePointer ? '横スクロール' : '横スワイプ'}で残り${layout.panes.length - visibleCount}つ`
        : `${layout.panes.length} ペイン`;

  const sidebarShown = layout.sidebarOpen;
  const maxPane = maximized ? layout.panes.find((p) => p.id === maximized) : undefined;

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--border)', gap: 1, paddingBottom: 'var(--safe-bottom)' }}>
      <header style={{ flex: 'none', minHeight: 52, padding: 'var(--safe-top) 12px 0 8px', background: 'var(--bg-muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-ghost btn-icon" aria-label={sidebarShown ? '一覧を畳む' : '一覧を広げる'} aria-pressed={sidebarShown} onClick={() => update((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))}>
          <IconSidebar />
        </button>
        <h1 style={{ fontSize: 15, fontWeight: 600 }}>AgentPWA</h1>
        <div role="group" aria-label="レイアウト" style={{ display: 'flex', marginLeft: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', flex: 'none' }}>
          {MODES.filter((m) => m.mode !== 'custom' || isFinePointer || wide).map((m, i, arr) => {
            const Icon = LayoutIcons[m.mode];
            const on = layout.mode === m.mode;
            return (
              <button
                key={m.mode}
                aria-label={m.label}
                title={m.label}
                aria-pressed={on}
                onClick={() => {
                  setMaximized(null);
                  update((l) => ({ ...l, mode: m.mode }));
                }}
                style={{ width: 40, height: 32, border: 'none', borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none', background: on ? 'var(--border)' : 'var(--btn-bg)', color: on ? 'var(--fg)' : 'var(--fg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
              >
                <Icon />
              </button>
            );
          })}
        </div>
        <span className="muted ellipsis" style={{ fontSize: 12 }}>{hint}</span>
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
            }} showArchived={showArchived} onSettings={() => setSettings(true)} />
        ) : (
          <Rail layout={layout} update={update} onSettings={() => setSettings(true)} />
        )}
        <main style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' }}>
          {maxPane ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>{renderPane(maxPane, layout.panes.indexOf(maxPane))}</div>
          ) : layout.mode === 'custom' ? (
            <CustomPanes layout={layout} update={update} renderPane={renderPane} />
          ) : (
            <GridPanes layout={layout} renderPane={renderPane} />
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
              return target && !target.sessionId ? setPaneSession(l, target.id, s.id) : addPane(l, s.id);
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
              <Settings showArchived={showArchived} setShowArchived={setShowArchived} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
