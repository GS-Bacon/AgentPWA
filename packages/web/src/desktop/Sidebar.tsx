// iPad / Web の左の一覧: プロジェクト（作業フォルダ）ごとにセッションをまとめる。
// AI はプロジェクトごとに固定なので、プロジェクト名の横のアイコンだけで示す。
import { useCallback, useState } from 'react';
import type { AgentKind } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';
import { getState, moveProject, useStore, waitingCount } from '../lib/store.ts';
import { AGENT_COLOR, AGENT_LABEL, elapsed } from '../lib/format.ts';
import { openSessionInNewPane, type LayoutState } from '../lib/layout.ts';
import { archivedSessions, buildProjects, type Project } from '../lib/projects.ts';
import { useNow } from '../components/Requests.tsx';
import { AutoWarn, ConnState, ContextMenu, sessionMenuItems, StatusLabel, UsageBars, useLongPress } from '../components/common.tsx';
import { AgentIcon, IconGear, IconPlus, ProjectSwatch } from '../components/Icons.tsx';

export const DRAG_TYPE = 'application/x-agentpwa-session';
/** プロジェクトの並べ替え用（ペインへのドロップとは別の種類にする） */
const PROJECT_DRAG_TYPE = 'application/x-agentpwa-project';

/**
 * ドラッグしたプロジェクト（from）を、target の前か後ろへ動かす。並び順は設定ファイルの folders の順（全端末で共有）。
 */
function dropProject(from: string, target: string, after: boolean): void {
  const folders = getState().info?.folders ?? [];
  const i = folders.findIndex((f) => f.path === from);
  let to = folders.findIndex((f) => f.path === target);
  if (i < 0 || to < 0 || from === target) return;
  if (after) to++;
  if (i < to) to--;
  void moveProject(from, to);
}
export const isWaiting = (id: string) => (getState().sessions[id]?.rank ?? 9) <= 2;

type Update = (fn: (s: LayoutState) => LayoutState) => void;
/** 行の右クリック・長押しでメニューを開く */
type OnMenu = (id: string, x: number, y: number) => void;

function SideRow({ s, paneNo, selected, now, onOpen, onMenu }: { s: SessionSummary; paneNo?: number; selected: boolean; now: number; onOpen: () => void; onMenu: OnMenu }) {
  const longPress = useLongPress((x, y) => onMenu(s.id, x, y));
  const sub = s.archived ? (
    <span className="srow-sub ellipsis muted">
      {s.folderName} · {elapsed(s.updatedAt, now)}
    </span>
  ) : s.rank <= 3 ? (
      <span className="srow-sub ellipsis">
        <StatusLabel s={s} withTime now={now} />
      </span>
    ) : s.rank === 4 ? (
      <span className="srow-sub mono muted ellipsis">{s.activity ?? '作業中…'}</span>
    ) : (
      <span className="srow-sub ellipsis muted">
        {s.status === 'stopped' ? '停止' : s.status === 'error' ? 'エラー' : 'アイドル'} · {elapsed(s.updatedAt, now)}
      </span>
    );
  return (
    <div
      className={`srow${s.rank === 1 ? ' srow-attention' : ''}${selected ? ' selected' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(s.id, e.clientX, e.clientY);
      }}
      {...longPress}
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
        // キーボードでもメニューを開ける（Shift+F10 / コンテキストメニューキー）
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(s.id, r.left + 24, r.bottom);
        }
      }}
      title={s.title}
      style={{ paddingLeft: selected ? 26 : 28 }}
    >
      {(s.rank >= 4 || s.archived) && (
        <span className="dot" style={{ color: s.rank === 4 ? 'var(--running)' : s.status === 'error' ? 'var(--danger)' : 'var(--fg-faint)' }} aria-hidden="true">
          ●
        </span>
      )}
      <span className="srow-main">
        <span className="srow-title ellipsis" style={s.rank === 5 ? { fontWeight: 500 } : undefined}>{s.title}</span>
        {sub}
      </span>
      <AutoWarn s={s} />
      {paneNo && (
        <span className="pane-tag" title={`ペイン${paneNo}で表示中`}>
          {paneNo}
        </span>
      )}
    </div>
  );
}

function ProjectGroup({
  p,
  collapsed,
  toggle,
  onNew,
  layout,
  update,
  now,
  onMenu,
}: {
  p: Project;
  collapsed: boolean;
  toggle: () => void;
  onNew: (cwd: string) => void;
  layout: LayoutState;
  update: Update;
  now: number;
  onMenu: OnMenu;
}) {
  const paneNo = new Map(layout.panes.map((x, i) => [x.sessionId, i + 1]));
  const focusedSession = layout.panes.find((x) => x.id === layout.focused)?.sessionId;
  // 並べ替えでドラッグ中のプロジェクトが、この見出しの上半分（before）か下半分（after）にあるか
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null);
  const accepts = (e: React.DragEvent) => p.registered && e.dataTransfer.types.includes(PROJECT_DRAG_TYPE);
  return (
    <div>
      <div
        draggable={p.registered}
        onDragStart={(e) => {
          e.dataTransfer.setData(PROJECT_DRAG_TYPE, p.path);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const r = e.currentTarget.getBoundingClientRect();
          setDropAt(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          const from = e.dataTransfer.getData(PROJECT_DRAG_TYPE);
          const r = e.currentTarget.getBoundingClientRect();
          setDropAt(null);
          if (from) dropProject(from, p.path, e.clientY >= r.top + r.height / 2);
        }}
        onDragEnd={() => setDropAt(null)}
        title={p.registered ? 'ドラッグで並べ替え' : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px 0 8px', minHeight: 36, borderBottom: '1px solid var(--border)',
          background: 'var(--bg-muted)', position: 'sticky', top: 0, zIndex: 1,
        }}
      >
        {dropAt && (
          <span aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, height: 2, background: 'var(--link)', pointerEvents: 'none', ...(dropAt === 'before' ? { top: -1 } : { bottom: -1 }) }} />
        )}
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          style={{ all: 'unset', cursor: 'pointer', flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0' }}
          title={`${p.path}（${AGENT_LABEL[p.agent]}）`}
        >
          <span aria-hidden="true" style={{ color: 'var(--fg-muted)', width: 12, display: 'inline-block', transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .1s' }}>
            ▸
          </span>
          <AgentIcon agent={p.agent} />
          <span className="ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
          <ProjectSwatch color={p.color} />
          {!p.registered && <span className="muted" style={{ fontSize: 11, flex: 'none' }}>登録外</span>}
          <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{p.sessions.length}</span>
        </button>
        {p.waiting > 0 && <span className="count">{p.waiting}</span>}
        {p.registered && (
          <button className="btn btn-ghost btn-icon-sm" aria-label={`${p.name} で新しいセッション`} title="このプロジェクトで新しいセッション" onClick={() => onNew(p.path)}>
            <IconPlus size={14} />
          </button>
        )}
      </div>
      {!collapsed &&
        (p.sessions.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, padding: '8px 28px', borderBottom: '1px solid #3d444d80' }}>セッションはありません</div>
        ) : (
          p.sessions.map((s) => (
            <SideRow key={s.id} s={s} now={now} paneNo={paneNo.get(s.id)} selected={s.id === focusedSession} onOpen={() => update((l) => openSessionInNewPane(l, s.id))} onMenu={onMenu} />
          ))
        ))}
    </div>
  );
}

export function Sidebar({
  layout,
  update,
  onNew,
  archivedOpen,
  setArchivedOpen,
  onSettings,
}: {
  layout: LayoutState;
  update: Update;
  onNew: (cwd?: string) => void;
  archivedOpen: boolean;
  setArchivedOpen: (v: boolean) => void;
  onSettings: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const info = useStore((s) => s.info);
  const usage = useStore((s) => s.usage);
  const [q, setQ] = useState('');
  const now = useNow();
  const query = q.trim().toLowerCase();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const onMenu = useCallback<OnMenu>((id, x, y) => setMenu({ id, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuSession = menu ? sessions[menu.id] : undefined;
  let projects = buildProjects(info, sessions);
  let archived = archivedSessions(sessions);
  if (query) {
    projects = projects
      .map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.title.toLowerCase().includes(query)) }))
      .filter((p) => p.sessions.length > 0 || p.name.toLowerCase().includes(query));
    archived = archived.filter((s) => s.title.toLowerCase().includes(query));
  }
  const paneNo = new Map(layout.panes.map((x, i) => [x.sessionId, i + 1]));
  const focusedSession = layout.panes.find((x) => x.id === layout.focused)?.sessionId;
  const usageAgents = (['claude', 'codex'] as AgentKind[]).filter((a) => usage[a].length > 0);
  const collapsed = new Set(layout.collapsed);
  const total = waitingCount(sessions);
  return (
    <aside style={{ width: 300, flex: 'none', background: 'var(--bg-muted)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 40, borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>プロジェクト</h2>
        {total > 0 && (
          <span style={{ fontSize: 12, color: 'var(--attention)', fontWeight: 600 }}>
            {total} 件があなた待ち
          </span>
        )}
      </div>
      {usageAgents.length > 0 && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {usageAgents.map((a) => (
            <div key={a} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: AGENT_COLOR[a], display: 'flex', alignItems: 'center', gap: 4 }}>
                <AgentIcon agent={a} size={12} /> {AGENT_LABEL[a]}
              </span>
              <UsageBars usage={usage[a]} />
            </div>
          ))}
        </div>
      )}
      <div style={{ padding: '8px 10px', display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <label htmlFor="side-search" className="sr-only">セッションを検索</label>
        <input id="side-search" type="search" className="input" placeholder="検索…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, height: 32, padding: '4px 8px' }} />
        <button className="btn" style={{ height: 32 }} onClick={() => onNew()}>
          ＋ 新規
        </button>
      </div>
      <div style={{ flex: '1 1 auto', overflowY: 'auto', minHeight: 0 }}>
        {projects.length === 0 && <div className="empty">{query ? '見つかりません' : '作業フォルダが登録されていません'}</div>}
        {projects.map((p) => (
          <ProjectGroup
            key={p.key}
            p={p}
            collapsed={!query && collapsed.has(p.key)}
            toggle={() => update((l) => ({ ...l, collapsed: l.collapsed.includes(p.key) ? l.collapsed.filter((k) => k !== p.key) : [...l.collapsed, p.key] }))}
            onNew={(cwd) => onNew(cwd)}
            layout={layout}
            update={update}
            now={now}
            onMenu={onMenu}
          />
        ))}
        {archived.length > 0 && (
          <div>
            <button
              className="archive-head"
              onClick={() => setArchivedOpen(!archivedOpen)}
              aria-expanded={archivedOpen || Boolean(query)}
            >
              <span aria-hidden="true" style={{ width: 12, display: 'inline-block', transform: archivedOpen || query ? 'rotate(90deg)' : 'none', transition: 'transform .1s' }}>
                ▸
              </span>
              アーカイブ済み（{archived.length}）
            </button>
            {(archivedOpen || query) &&
              archived.map((s) => (
                <SideRow key={s.id} s={s} now={now} paneNo={paneNo.get(s.id)} selected={s.id === focusedSession} onOpen={() => update((l) => openSessionInNewPane(l, s.id))} onMenu={onMenu} />
              ))}
          </div>
        )}
      </div>
      {menu && menuSession && <ContextMenu x={menu.x} y={menu.y} items={sessionMenuItems(menuSession)} onClose={closeMenu} />}
      <div style={{ borderTop: '1px solid var(--border)', padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <ConnState />
        <span />
        <button className="btn btn-ghost" style={{ height: 30 }} onClick={onSettings}>
          <IconGear /> 設定
        </button>
      </div>
    </aside>
  );
}

/** 一覧を畳んだときの細い帯（iPad 向け） */
export function Rail({ layout, update, onSettings }: { layout: LayoutState; update: Update; onSettings: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const n = waitingCount(sessions);
  return (
    <nav aria-label="セッション" style={{ width: 60, flex: 'none', background: 'var(--bg-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0' }}>
      <button
        aria-label={`プロジェクト一覧${n ? `（待ち${n}）` : ''}`}
        className="btn btn-ghost"
        style={{ width: 44, height: 44, padding: 0, position: 'relative', color: 'var(--fg)' }}
        onClick={() => update((s) => ({ ...s, sidebarOpen: true }))}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h7l2 2h9v11H3z" />
        </svg>
        {n > 0 && <span className="count" style={{ position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, fontSize: 10 }}>{n}</span>}
      </button>
      <span style={{ width: 32, height: 1, background: 'var(--border)', margin: '4px 0' }} />
      {layout.panes.map((p, i) => {
        const s = p.sessionId ? sessions[p.sessionId] : undefined;
        const waiting = s && s.rank <= 2;
        const focused = layout.focused === p.id;
        return (
          <button
            key={p.id}
            aria-label={`ペイン${i + 1}${s ? ` ${s.title}` : p.view ? ` ファイル ${p.view.path}` : '（空）'}`}
            onClick={() => update((l) => ({ ...l, focused: p.id }))}
            className={`btn${waiting ? ' btn-attention' : ''}`}
            style={{ width: 44, height: 36, padding: 0, fontSize: 12, fontWeight: 600, borderStyle: s || p.view ? 'solid' : 'dashed', outline: focused ? '2px solid var(--link)' : undefined, outlineOffset: -2 }}
          >
            {i + 1}
          </button>
        );
      })}
      <span style={{ flex: 1 }} />
      <button className="btn btn-ghost" aria-label="設定" style={{ width: 44, height: 44, padding: 0 }} onClick={onSettings}>
        <IconGear size={20} />
      </button>
    </nav>
  );
}
