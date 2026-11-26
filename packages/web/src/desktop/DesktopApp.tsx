// iPad / Web: 左の一覧と、何枚でも並べられるペイン。
// 並べ方は VS Code のエディターグループと同じ操作: ペインの見出しをドラッグして、ほかのペインの上下左右の端に落とすと分割、
// 中央に落とすと入れ替え。境界をドラッグして大きさを変え、境界のダブルクリックで均等にする。
// 画面に収まらないときは横スクロール（iPad は横スワイプ）で表示する。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { SessionSummary } from '@agentpwa/hub/api';
import { discardIfEmpty, getState, isUnreadOrWaiting, needsAnswer, onSessionCreatedByAgent, onSessionsClosed, run, sortedSessions, useStore } from '../lib/store.ts';
import { isRunning, projectHeadStyle } from '../lib/format.ts';
import { isFolder, useProjectColor, type ProjectRef } from '../lib/projects.ts';
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
import { NewSessionForm, startSessionIn } from '../components/NewSession.tsx';
import { Settings } from '../components/Settings.tsx';
import { FileViewer } from '../components/FileViewer.tsx';
import { onOpenFile } from '../lib/viewer.ts';
import { expectLanding, paneRect, playLandings } from './paneMotion.ts';
import { getPaneDrag, setPaneDrag, usePaneDrag } from './paneDrag.ts';
import { AgentIcon, IconClose, IconMaximize, IconSidebar } from '../components/Icons.tsx';

/** ペインを動かすドラッグのデータの種類 */
const PANE_DRAG_TYPE = 'application/x-agentpwa-pane';
/** ドラッグ中のペイン（dragover の間は dataTransfer の中身を読めないため、ここに持つ） */
let draggingPane: string | null = null;

/** ドロップ先の重ね表示の位置 */
// 分割後のペインの形が分かるように、ペインの縁から少し内側に、新しいペインが入る半分を四角で示す
// 範囲が変わるときに VS Code と同じく滑らかに動かせるよう、どの範囲も left / top / width / height で表す（styles.css の .drop-overlay）
const G = 4;
const HALF = `calc(50% - ${G * 1.5}px)`;
const FAR = `calc(50% + ${G / 2}px)`;
const FULL = `calc(100% - ${G * 2}px)`;
const ZONE_STYLE: Record<DropZone, React.CSSProperties> = {
  left: { left: G, top: G, width: HALF, height: FULL },
  right: { left: FAR, top: G, width: HALF, height: FULL },
  top: { left: G, top: G, width: FULL, height: HALF },
  bottom: { left: G, top: FAR, width: FULL, height: HALF },
  center: { left: G, top: G, width: FULL, height: FULL },
};
/** 分割したときに、元のペインが残る側（新しいペインの反対側）。中央のときは出さない */
const REST_ZONE: Record<DropZone, DropZone> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top', center: 'center' };
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

/** ドラッグ中の説明に出す、ペインの番号と名前（番号は見出しの左の数字と同じ） */
function paneTitle(p: Pane | undefined, sessions: Record<string, SessionSummary>, panes: Pane[]): string {
  if (!p) return '';
  const name = p.view ? p.view.path.split(/[\\/]/).pop() || p.view.path : (p.sessionId && sessions[p.sessionId]?.title) || '空のペイン';
  return `ペイン${panes.indexOf(p) + 1}「${name}」`;
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
  const color = useProjectColor(s);
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
  // ペインを閉じて自動でフォーカスが移っただけのペイン（触るまで既読にしない）
  const passive = focused && layout.passiveFocus === pane.id;
  const focusPane = (e: React.SyntheticEvent) => {
    // 閉じるボタンを押しただけでは、そのペインにフォーカスを移さない（閉じる前に既読になるのを防ぐ）
    if ((e.target as HTMLElement).closest?.('[data-close-pane]')) return;
    if (!focused || passive) update((l) => ({ ...l, focused: pane.id }));
  };
  const waiting = needsAnswer(s);

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
    // dragstart の中で画面を書き換えると Chrome はドラッグを取りやめることがあるので、次の順番で印を付ける
    const id = pane.id;
    setTimeout(() => {
      if (draggingPane === id) setPaneDrag({ source: id, target: null, zone: null });
    }, 0);
  };
  const onHeadDragEnd = () => {
    draggingPane = null;
    setPaneDrag(null);
  };

  // ペインのドラッグと、一覧からのセッションのドラッグを受け付ける
  const dropTarget = {
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      const isPane = types.includes(PANE_DRAG_TYPE);
      if (!isPane && !types.includes(DRAG_TYPE)) return;
      if (isPane && draggingPane === pane.id) {
        setZone(null);
        setPaneDrag({ source: pane.id, target: null, zone: null });
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = isPane ? 'move' : 'copy';
      const z = zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      if (z !== zone) setZone(z);
      // 掴んだペインの側にも、落とすとどうなるかを出す
      if (isPane && draggingPane) setPaneDrag({ source: draggingPane, target: pane.id, zone: z });
      const kind = isPane ? 'pane' : 'session';
      if (kind !== dragKind) setDragKind(kind);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Safari などは relatedTarget が空のことがあるので、ポインターがペインの外に出たかを位置で見る
      // （中の要素をまたぐたびに消えると、重ね表示がちらつく）
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) {
        setZone(null);
        const d = getPaneDrag();
        if (d?.target === pane.id) setPaneDrag({ ...d, target: null, zone: null });
      }
    },
    onDrop: (e: React.DragEvent) => {
      const z = zone ?? zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      setZone(null);
      setPaneDrag(null);
      const paneId = e.dataTransfer.getData(PANE_DRAG_TYPE);
      const sessionId = e.dataTransfer.getData(DRAG_TYPE);
      if (!paneId && !sessionId) return;
      e.preventDefault();
      // 動いた・増えたペインが分かるように、ドロップの枠を新しい位置まで飛ばす（paneMotion.ts）
      const here = e.currentTarget.getBoundingClientRect();
      const overlay = e.currentTarget.querySelector('.drop-overlay')?.getBoundingClientRect() ?? here;
      if (paneId && z === 'center') {
        // 入れ替え: 2枚がそれぞれ相手の位置へ動く
        expectLanding(() => paneId, paneRect(paneId));
        expectLanding(() => pane.id, here);
      } else if (paneId) expectLanding(() => paneId, overlay);
      else if (z === 'center') expectLanding(() => pane.id, null);
      else expectLanding((l) => l.panes.find((p) => p.sessionId === sessionId)?.id, overlay);
      setMaximized(null);
      if (paneId) update((l) => movePane(l, paneId, pane.id, z));
      else update((l) => dropSession(l, sessionId, pane.id, z));
    },
  };
  // ドロップすると何が起きるかを、落とす前に範囲と文字で示す（VS Code と同じく、分割なら新しいペインが入る半分を塗り、
  // 範囲が変わるときは四角が滑らかに動く）。掴んだペインの名前も出して、どのペインがここに来るかを分かるようにする
  const drag = usePaneDrag();
  const srcTitle = dragKind === 'pane' && drag ? paneTitle(layout.panes.find((p) => p.id === drag.source), sessions, layout.panes) : '';
  const dropOverlay = zone && (
    <>
      <div aria-hidden className="drop-rest" style={{ ...ZONE_STYLE[REST_ZONE[zone]], opacity: zone === 'center' ? 0 : 1 }} />
      <div aria-hidden className="drop-overlay" style={ZONE_STYLE[zone]}>
        <span className="drop-label">
          <b>{zone === 'center' ? (dragKind === 'pane' ? '入れ替え' : 'このペインに表示') : ZONE_LABEL[zone]}</b>
          {srcTitle && <span className="drop-sub ellipsis">{srcTitle}がここに来ます</span>}
        </span>
      </div>
    </>
  );
  // 掴んでいるペインの側: 落とした後、ここがどうなるか（入れ替えなら相手のペインが来る、分割・移動ならここは詰まる）
  const sourceOverlay = drag?.source === pane.id && (
    <div aria-hidden className={`drag-source${drag.target && drag.zone === 'center' ? ' swap' : ''}`}>
      <span className="drop-label">
        {!drag.target ? (
          <b>移動するペイン</b>
        ) : drag.zone === 'center' ? (
          <>
            <b>入れ替え</b>
            <span className="drop-sub ellipsis">{paneTitle(layout.panes.find((p) => p.id === drag.target), sessions, layout.panes)}がここに来ます</span>
          </>
        ) : (
          <>
            <b>ここから移動</b>
            <span className="drop-sub">この場所は詰まり、隣のペインが広がります</span>
          </>
        )}
      </span>
    </div>
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
        data-close-pane
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
        onMouseDownCapture={focusPane}
        onFocusCapture={focusPane}
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
        {sourceOverlay}
      </section>
    );
  }

  return (
    <section
      data-pane={pane.id}
      aria-label={`ペイン${index + 1}`}
      tabIndex={-1}
      onMouseDownCapture={focusPane}
      onFocusCapture={focusPane}
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
          // プロジェクトの色（設定画面で選ぶ）で左端の帯と背景を塗り、どのプロジェクトのペインかを見分けやすくする
          ...projectHeadStyle(color),
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
        <SessionView key={s.id} session={s} focused={focused} autoRead={!passive} />
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
      {dropOverlay}
      {sourceOverlay}
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
  // 新しいセッションの画面。project は初めに選んでおくプロジェクト
  const [newSession, setNewSession] = useState<{ project?: ProjectRef } | null>(null);
  const [settings, setSettings] = useState(false);
  const [maximized, setMaximized] = useState<string | null>(null);
  // ドロップで並びが変わったら、着地の動きを見せる
  useLayoutEffect(() => playLandings(layout), [layout, maximized]);
  const isFinePointer = useMemo(() => window.matchMedia('(pointer: fine)').matches, []);

  // 未読（確認待ちも含む）と、確認待ち（許可・質問のカードが出ている）
  const unread = sortedSessions(sessions).filter(isUnreadOrWaiting);
  const asking = sortedSessions(sessions).filter(needsAnswer);

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

  // 条件に合うセッションへ順に移動する
  const goNext = useCallback(
    (pick: (s: SessionSummary) => boolean) => {
      update((l) => {
        const list = sortedSessions(getState().sessions).filter(pick);
        if (list.length === 0) return l;
        const cur = l.panes.find((p) => p.id === l.focused)?.sessionId;
        const idx = list.findIndex((s) => s.id === cur);
        const next = list[(idx + 1) % list.length];
        return openSession(l, next.id, isWaiting);
      });
    },
    [update],
  );
  const nextUnread = useCallback(() => goNext(isUnreadOrWaiting), [goNext]);
  const nextAsking = useCallback(() => goNext(needsAnswer), [goNext]);

  // フォーカスが移ったペインを画面内に入れる
  useEffect(() => {
    const el = document.querySelector(`[data-pane="${layout.focused}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [layout.focused]);

  // キーボード: Alt+J で次の未読へ、Alt+K で確認待ちへ、Alt+1〜9 でペインへ、Enter でフォーカス中ペインの許可、Esc でフォーカス中ペインの中断
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
        nextUnread();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyK') {
        e.preventDefault();
        nextAsking();
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
  }, [layout, nextUnread, nextAsking, update]);

  // 新しいセッションを、フォーカス中の空のペインか新しいペインで開く
  const showCreated = (id: string) => {
    setMaximized(null);
    update((l) => {
      const target = l.panes.find((p) => p.id === l.focused);
      return target && isEmptyPane(target) ? setPaneSession(l, target.id, id) : addPane(l, id);
    });
  };

  // プロジェクト横の＋: 画面を挟まずに、そのプロジェクトで（前回のモデルとエフォートで）始めてペインで開く
  const starting = useRef(false);
  const startIn = async (project: ProjectRef) => {
    const folder = getState().info?.folders.find((f) => isFolder(f, project.path, project.agent));
    if (!folder) {
      setNewSession({ project });
      return;
    }
    if (starting.current) return;
    starting.current = true;
    try {
      const s = await startSessionIn(folder);
      if (s) showCreated(s.id);
    } finally {
      starting.current = false;
    }
  };

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
        <button className="btn" onClick={nextUnread} disabled={unread.length === 0} title="未読のセッション（確認待ちを含む）へ順に移動（Alt+J）">
          次の未読へ
          {isFinePointer && <kbd>Alt+J</kbd>}
          {unread.length > 0 && <span className="count">{unread.length}</span>}
        </button>
        <button className={`btn${asking.length ? ' btn-attention' : ''}`} onClick={nextAsking} disabled={asking.length === 0} title="許可・質問が出ているセッションへ順に移動（Alt+K）">
          確認待ちへ
          {isFinePointer && <kbd>Alt+K</kbd>}
          {asking.length > 0 && <span className="count">{asking.length}</span>}
        </button>
        <button className="btn" onClick={() => update((l) => addPane(l))}>
          ＋ ペイン
        </button>
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 1 }}>
        {sidebarShown ? (
          <Sidebar layout={layout} update={update} onNew={(project) => {
              // プロジェクトの指定がなければ、フォーカス中のペインのセッションのプロジェクトにする
              const sid = layout.panes.find((p) => p.id === layout.focused)?.sessionId;
              const s = sid ? sessions[sid] : undefined;
              setNewSession({ project: project ?? (s ? { path: s.cwd, agent: s.agent } : undefined) });
            }} onStartIn={(project) => void startIn(project)} archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} onSettings={() => setSettings(true)} />
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
          project={newSession.project}
          onClose={() => setNewSession(null)}
          onCreated={(s) => {
            setNewSession(null);
            showCreated(s.id);
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
