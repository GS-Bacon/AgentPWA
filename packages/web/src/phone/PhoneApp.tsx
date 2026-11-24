// iPhone: 下部タブ（セッション / 設定）と、上部のプロジェクトのタブ（すべて / プロジェクト…）。
// AI はプロジェクトごとに固定なので、プロジェクトのタブの横のアイコンで示す。
// セッションの詳細へは1画面ずつ遷移する。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentpwa/hub/api';
import { discardIfEmpty, onSessionCreatedByAgent, onSessionsClosed, sortedSessions, useStore, waitingCount } from '../lib/store.ts';
import type { ArchiveSectionProps } from '../App.tsx';
import { elapsed, projectHeadStyle, shortPath, timeLabel } from '../lib/format.ts';
import { archivedSessions, buildProjects, findProject, useProjectColor, type Project, type ProjectRef } from '../lib/projects.ts';
import { archiveSession, deleteSession, setPinned, setUnread, unarchiveSession } from '../lib/sessionActions.ts';
import { ApprovalInline, useNow } from '../components/Requests.tsx';
import { AutoWarn, ConnState, PinMark, SessionMenu, ShowMoreButton, StatusLabel, useShowMore } from '../components/common.tsx';
import { SessionView } from '../components/SessionView.tsx';
import { NewSessionForm } from '../components/NewSession.tsx';
import { Settings } from '../components/Settings.tsx';
import { FileViewer } from '../components/FileViewer.tsx';
import { onOpenFile } from '../lib/viewer.ts';
import { AgentIcon, IconBack, IconGear, IconPlus, ProjectSwatch } from '../components/Icons.tsx';

type Route =
  | { name: 'list'; project: string | null }
  | { name: 'settings' }
  | { name: 'session'; id: string }
  | { name: 'file'; id: string; path: string }
  | { name: 'new'; project?: ProjectRef };

function parse(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const [, a, b] = path.split('/');
  if (a === 'settings') return { name: 'settings' };
  if (a === 's' && b) return { name: 'session', id: b };
  if (a === 'f' && b) return { name: 'file', id: b, path: new URLSearchParams(query).get('path') ?? '' };
  if (a === 'p' && b) return { name: 'list', project: decodeURIComponent(b) };
  if (a === 'new') {
    const q = new URLSearchParams(query);
    const cwd = q.get('cwd');
    const agent = q.get('agent') === 'codex' ? 'codex' : 'claude';
    return { name: 'new', project: cwd ? { path: cwd, agent } : undefined };
  }
  return { name: 'list', project: null };
}

function useRoute(): [Route, (hash: string, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (hash: string, replace = false) => {
    if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
    setRoute(parse(hash));
  };
  return [route, go];
}

/** セッションの行。「すべて」ではプロジェクト名（と AI のアイコン）、プロジェクトのタブではマシン名を添える */
function PhoneRow({ s, now, onOpen, showProject }: { s: SessionSummary; now: number; onOpen: () => void; showProject: boolean }) {
  const place = showProject ? (
    <>
      <AgentIcon agent={s.agent} size={12} /> {s.folderName || shortPath(s.cwd)}
    </>
  ) : (
    s.machine
  );
  if (s.rank <= 3) {
    const approval = s.pendingApprovals[0];
    const question = s.pendingQuestions[0];
    return (
      <article className={`row${s.rank === 1 ? ' row-attention' : ''}`} onClick={onOpen} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
        <div className="row-top">
          <StatusLabel s={s} />
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <PinMark s={s} />
            <AutoWarn s={s} />
            <span className="muted">{timeLabel(s, now)}</span>
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h3 className="row-title">{s.title}</h3>
          <p className="row-sub">{place}</p>
        </div>
        {approval && <ApprovalInline session={s} req={approval} />}
        {question && <p style={{ fontSize: 14, lineHeight: 1.5 }}>{question.prompt}</p>}
        {s.rank === 3 && s.activity && <p className="row-sub ellipsis">{s.activity}</p>}
      </article>
    );
  }
  const dotColor = s.rank === 4 ? 'var(--running)' : s.status === 'error' ? 'var(--danger)' : 'var(--fg-faint)';
  return (
    <div className="row row-compact" onClick={onOpen} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <span className="dot" style={{ color: dotColor }} aria-hidden="true">●</span>
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="row-title ellipsis">{s.title}</span>
        <span className="muted ellipsis" style={{ fontSize: 12 }}>
          {s.rank === 4 ? (
            <>
              {showProject && <>{place} · </>}
              <span className="mono">{s.activity ?? '作業中…'}</span>
            </>
          ) : (
            place
          )}
        </span>
      </div>
      <PinMark s={s} />
      <AutoWarn s={s} />
      <span className="muted" style={{ fontSize: 12, flex: 'none' }}>{s.archived ? elapsed(s.updatedAt, now) : timeLabel(s, now)}</span>
    </div>
  );
}

const SWIPE_BTN_W = 72;

interface SwipeAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * 左にスワイプすると操作のボタン（ピン止め・未読・アーカイブ・削除）が出る行。
 * 縦のスクロールはブラウザに任せ（touch-action: pan-y）、横の動きだけを扱う。開いている行は1つだけ。
 */
function SwipeRow({ id, openId, setOpenId, actions, children }: { id: string; openId: string | null; setOpenId: (id: string | null) => void; actions: SwipeAction[]; children: React.ReactNode }) {
  const width = actions.length * SWIPE_BTN_W;
  const open = openId === id;
  const [drag, setDrag] = useState<number | null>(null);
  // 指を離したときの判定は、描画を待たずに最新の位置で行う（速いスワイプでも取りこぼさない）
  const st = useRef<{ x: number; y: number; base: number; decided: boolean; horiz: boolean; pos: number } | null>(null);
  const moved = useRef(false);
  const offset = drag ?? (open ? -width : 0);
  const end = () => {
    const s0 = st.current;
    st.current = null;
    if (s0?.horiz) setOpenId(s0.base === 0 ? (s0.pos < -48 ? id : null) : s0.pos > -width + 48 ? null : id);
    setDrag(null);
  };
  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      <div className="swipe-actions" style={{ width }} aria-hidden={!open}>
        {actions.map((a) => (
          <button
            key={a.label}
            className={a.danger ? 'swipe-btn swipe-danger' : 'swipe-btn'}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              setOpenId(null);
              a.onClick();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="swipe-content"
        style={{ transform: `translateX(${offset}px)`, transition: drag === null ? 'transform .18s ease-out' : 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          moved.current = false;
          st.current = { x: e.clientX, y: e.clientY, base: open ? -width : 0, decided: false, horiz: false, pos: open ? -width : 0 };
        }}
        onPointerMove={(e) => {
          const s0 = st.current;
          if (!s0) return;
          const dx = e.clientX - s0.x;
          const dy = e.clientY - s0.y;
          if (!s0.decided) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            s0.decided = true;
            s0.horiz = Math.abs(dx) > Math.abs(dy);
            if (s0.horiz) e.currentTarget.setPointerCapture(e.pointerId);
          }
          if (!s0.horiz) return;
          moved.current = true;
          s0.pos = Math.max(-width - 24, Math.min(0, s0.base + dx));
          setDrag(s0.pos);
        }}
        onPointerUp={end}
        onPointerCancel={() => {
          st.current = null;
          setDrag(null);
        }}
        onClickCapture={(e) => {
          // スワイプの直後のクリックと、開いている行のタップ（閉じるだけ）では、セッションを開かない
          if (moved.current) {
            moved.current = false;
            e.preventDefault();
            e.stopPropagation();
          } else if (open) {
            e.preventDefault();
            e.stopPropagation();
            setOpenId(null);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** 上部のプロジェクトのタブ（横にスクロール） */
function ProjectTabs({ projects, current, total, go }: { projects: Project[]; current: string | null; total: number; go: (h: string, replace?: boolean) => void }) {
  const ref = useRef<HTMLElement>(null);
  // 選んだタブが見えるようにする
  useLayoutEffect(() => {
    ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [current]);
  const tab = (key: string | null, label: React.ReactNode, count: number, title?: string) => {
    const on = current === key;
    return (
      <a
        key={key ?? 'all'}
        href={key ? `#/p/${encodeURIComponent(key)}` : '#/'}
        onClick={(e) => {
          e.preventDefault();
          go(key ? `#/p/${encodeURIComponent(key)}` : '#/', true);
        }}
        aria-current={on ? 'page' : undefined}
        title={title}
        style={{
          flex: 'none', height: 44, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none',
          borderBottom: `2px solid ${on ? 'var(--fg)' : 'transparent'}`, color: on ? 'var(--fg)' : 'var(--fg-muted)', fontWeight: on ? 600 : 500, fontSize: 13, whiteSpace: 'nowrap',
        }}
      >
        {label}
        {count > 0 && <span className="count" style={{ minWidth: 16, height: 16 }}>{count}</span>}
      </a>
    );
  };
  return (
    <nav ref={ref} aria-label="プロジェクト" style={{ flex: 'none', display: 'flex', background: 'var(--bg-muted)', borderBottom: '1px solid var(--border)', padding: '0 8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
      {tab(null, 'すべて', total)}
      {projects.map((p) =>
        tab(
          p.key,
          <>
            <AgentIcon agent={p.agent} />
            {p.name}
            <ProjectSwatch color={p.color} />
          </>,
          p.waiting,
          p.path,
        ),
      )}
    </nav>
  );
}

function ListScreen({ projectKey, archivedOpen, setArchivedOpen, go }: ArchiveSectionProps & { projectKey: string | null; go: (h: string, replace?: boolean) => void }) {
  const sessions = useStore((s) => s.sessions);
  const info = useStore((s) => s.info);
  const ready = useStore((s) => s.ready);
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const projects = buildProjects(info, sessions);
  const project = projectKey ? findProject(projects, projectKey) : undefined;
  const list = project ? project.sessions : sortedSessions(sessions);
  const archived = archivedSessions(sessions, project?.key);
  const row = (s: SessionSummary) => (
    <SwipeRow
      key={s.id}
      id={s.id}
      openId={openId}
      setOpenId={setOpenId}
      actions={
        s.archived
          ? [
              { label: 'アーカイブを解除', onClick: () => void unarchiveSession(s.id) },
              { label: '削除', onClick: () => void deleteSession(s.id), danger: true },
            ]
          : [
              s.pinned ? { label: 'ピン止めを外す', onClick: () => void setPinned(s.id, false) } : { label: 'ピン止め', onClick: () => void setPinned(s.id, true) },
              s.unread ? { label: '既読にする', onClick: () => void setUnread(s.id, false) } : { label: '未読にする', onClick: () => void setUnread(s.id, true) },
              { label: 'アーカイブ', onClick: () => void archiveSession(s.id) },
              { label: '削除', onClick: () => void deleteSession(s.id), danger: true },
            ]
      }
    >
      <PhoneRow s={s} now={now} showProject={!project} onOpen={() => go(`#/s/${s.id}`)} />
    </SwipeRow>
  );
  const total = waitingCount(sessions);
  // ピン止めを先頭にまとめ、残りを「あなたの番 / 実行中 / アイドル」に分ける。アイドルとアーカイブ済みは多いと長いので、LIST_PAGE 件ずつ出す
  const pinned = list.filter((s) => s.pinned);
  const rest = list.filter((s) => !s.pinned);
  const mine = rest.filter((s) => s.rank <= 3);
  const running = rest.filter((s) => s.rank === 4);
  const idle = rest.filter((s) => s.rank === 5);
  const idlePage = useShowMore(idle);
  const archivedPage = useShowMore(archived);
  const newHash = project ? `#/new?cwd=${encodeURIComponent(project.path)}&agent=${project.agent}` : '#/new';
  const canCreate = !project || project.registered;
  return (
    <>
      <header style={{ flex: 'none', padding: 'calc(16px + var(--safe-top)) 16px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--bg-muted)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          {project ? (
            <>
              <h1 className="ellipsis" style={{ fontSize: 22, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <AgentIcon agent={project.agent} size={18} />
                {project.name}
              </h1>
              <p className="mono muted ellipsis" style={{ fontSize: 11 }}>{project.path}</p>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 22, fontWeight: 600 }}>セッション</h1>
              <p style={{ fontSize: 13 }} className="muted">
                {list.length} セッション
                {total > 0 && (
                  <>
                    {' · '}
                    <span style={{ color: 'var(--attention)', fontWeight: 600 }}>{total} 件があなた待ち</span>
                  </>
                )}{' '}
                <ConnState />
              </p>
            </>
          )}
        </div>
        {canCreate && (
          <button className="btn btn-lg" onClick={() => go(newHash)} style={{ flex: 'none' }}>
            <IconPlus />
            新規
          </button>
        )}
      </header>
      <ProjectTabs projects={projects} current={project ? project.key : null} total={total} go={go} />
      <main style={{ flex: '1 1 auto', overflowY: 'auto', minHeight: 0 }}>
        {ready && projectKey && !project && <div className="empty">プロジェクトが見つかりません</div>}
        {ready && list.length === 0 && (project || !projectKey) && (
          <div className="empty">
            <span>{projects.length === 0 ? '作業フォルダが登録されていません。Hub の設定ファイルの folders に追加してください。' : 'セッションはまだありません'}</span>
            {canCreate && projects.length > 0 && (
              <button className="btn btn-primary btn-lg" onClick={() => go(newHash)}>
                新しいセッションを始める
              </button>
            )}
          </div>
        )}
        {pinned.length > 0 && <h2 className="list-heading">ピン止め · {pinned.length}</h2>}
        {pinned.map(row)}
        {mine.length > 0 && <h2 className="list-heading">あなたの番 · {mine.length}</h2>}
        {mine.map(row)}
        {running.length > 0 && <h2 className="list-heading">実行中 · {running.length}</h2>}
        {running.map(row)}
        {idle.length > 0 && <h2 className="list-heading">アイドル · {idle.length}</h2>}
        {idlePage.shown.map(row)}
        <ShowMoreButton rest={idlePage.rest} onClick={idlePage.more} className="show-more show-more-lg" />
        {archived.length > 0 && (
          <>
            <button className="list-heading archive-toggle" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}>
              <span aria-hidden="true" style={{ width: 12, display: 'inline-block', transform: archivedOpen ? 'rotate(90deg)' : 'none', transition: 'transform .1s' }}>
                ▸
              </span>
              アーカイブ済み（{archived.length}）
            </button>
            {archivedOpen && (
              <>
                {archivedPage.shown.map(row)}
                <ShowMoreButton rest={archivedPage.rest} onClick={archivedPage.more} className="show-more show-more-lg" />
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

function DetailScreen({ id, back }: { id: string; back: () => void }) {
  const s = useStore((st) => st.sessions[id]);
  const color = useProjectColor(s);
  const now = useNow();
  if (!s) {
    return (
      <div className="empty" style={{ paddingTop: 'calc(48px + var(--safe-top))' }}>
        <span>セッションが見つかりません</span>
        <button className="btn" onClick={back}>戻る</button>
      </div>
    );
  }
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', paddingBottom: 'var(--safe-bottom)' }}>
      <header style={{ flex: 'none', padding: 'calc(8px + var(--safe-top)) 4px 8px 0', background: 'var(--bg-muted)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 2, ...projectHeadStyle(color) }}>
        <button className="btn btn-ghost" aria-label="戻る" onClick={back} style={{ width: 44, height: 44, padding: 0, color: 'var(--fg)' }}>
          <IconBack size={20} />
        </button>
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <h1 className="ellipsis" style={{ fontSize: 15, fontWeight: 600 }}>{s.title}</h1>
          <p className="ellipsis muted" style={{ fontSize: 12 }}>
            <AgentIcon agent={s.agent} size={12} /> {s.folderName} · <StatusLabel s={s} withTime now={now} /> <AutoWarn s={s} />
          </p>
        </div>
        <SessionMenu s={s} />
      </header>
      <SessionView session={s} focused subLayout="full" />
    </div>
  );
}

function TabBar({ route, go }: { route: Route; go: (h: string, replace?: boolean) => void }) {
  const sessions = useStore((s) => s.sessions);
  const active = route.name === 'settings' ? 'settings' : 'list';
  const tab = (key: 'list' | 'settings', hash: string, label: string, icon: React.ReactNode, count?: number) => {
    const on = active === key;
    return (
      <a
        href={hash}
        onClick={(e) => {
          e.preventDefault();
          go(hash, true);
        }}
        aria-current={on ? 'page' : undefined}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, textDecoration: 'none', color: on ? 'var(--fg)' : 'var(--fg-muted)', fontSize: 11, fontWeight: on ? 600 : 500 }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {icon}
          {count ? <span className="count" style={{ minWidth: 16, height: 16 }}>{count}</span> : null}
        </span>
        {label}
      </a>
    );
  };
  return (
    <nav aria-label="タブ" style={{ flex: 'none', minHeight: 58, padding: '6px 16px calc(6px + var(--safe-bottom))', background: 'var(--bg-muted)', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
      {tab(
        'list',
        '#/',
        'セッション',
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>,
        waitingCount(sessions),
      )}
      {tab('settings', '#/settings', '設定', <IconGear size={22} />)}
    </nav>
  );
}

export function PhoneApp({ archivedOpen, setArchivedOpen }: ArchiveSectionProps) {
  const [route, go] = useRoute();
  const back = () => {
    if (history.length > 1) history.back();
    else go('#/', true);
  };
  // 表示中のセッションがアーカイブ・削除されたら（どの端末で操作しても）一覧に戻る
  const routeRef = useRef(route);
  routeRef.current = route;
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(
    () =>
      onSessionsClosed((ids) => {
        const r = routeRef.current;
        if ((r.name === 'session' || r.name === 'file') && ids.includes(r.id)) goRef.current('#/', true);
      }),
    [],
  );
  // 会話の中のパスをタップしたら、全画面のビュワーを重ねて開く（戻るで会話に戻る）
  useEffect(() => onOpenFile((sid, path) => goRef.current(`#/f/${sid}?path=${encodeURIComponent(path)}`)), []);
  // AI が作ったセッションは、その会話の画面を開く（戻るで元の画面に戻る）
  useEffect(() => onSessionCreatedByAgent((id) => goRef.current(`#/s/${id}`)), []);
  // 表示していたセッションから離れたとき（一覧に戻った・別のセッションを開いた）、空なら消す
  const shownId = route.name === 'session' || route.name === 'file' ? route.id : null;
  const prevShown = useRef(shownId);
  useEffect(() => {
    const prev = prevShown.current;
    prevShown.current = shownId;
    if (prev && prev !== shownId) discardIfEmpty([prev]);
  }, [shownId]);

  if (route.name === 'session') return <DetailScreen id={route.id} back={back} />;
  if (route.name === 'file') {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
        <FileViewer
          sessionId={route.id}
          path={route.path}
          lead={
            <button className="btn btn-ghost" aria-label="閉じる" onClick={back} style={{ width: 44, height: 44, padding: 0, color: 'var(--fg)', flex: 'none' }}>
              <IconBack size={20} />
            </button>
          }
        />
      </div>
    );
  }
  if (route.name === 'new') {
    return <NewSessionForm project={route.project} fullscreen onClose={back} onCreated={(s) => go(`#/s/${s.id}`, true)} />;
  }
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {route.name === 'settings' ? (
        <>
          <header style={{ flex: 'none', padding: 'calc(16px + var(--safe-top)) 16px 12px', background: 'var(--bg-muted)', borderBottom: '1px solid var(--border)' }}>
            <h1 style={{ fontSize: 22, fontWeight: 600 }}>設定</h1>
          </header>
          <main style={{ flex: '1 1 auto', overflowY: 'auto' }}>
            <Settings fullscreen />
          </main>
        </>
      ) : (
        <ListScreen projectKey={route.project} archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} go={go} />
      )}
      <TabBar route={route} go={go} />
    </div>
  );
}
