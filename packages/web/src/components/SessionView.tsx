// セッションの中身（会話・許可要求・入力欄）。iPhone の詳細画面と、iPad / Web のペインで共通に使う。
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { getState, loadEvents, run, useStore } from '../lib/store.ts';
import { relPath } from '../lib/format.ts';
import { unarchiveSession } from '../lib/sessionActions.ts';
import { buildItems, buildSubagents, rewoundEvents, type Item, type SubagentInfo, type ToolItem } from '../lib/transcript.ts';
import { SubagentLine, SubCtx, SubPane, subLabel, subOfRequest, useSubCtx, type SubLayout, type SubPaneState } from './Subagents.tsx';
import { ApprovalCard, QuestionCard } from './Requests.tsx';
import { IconChevron } from './Icons.tsx';
import { Composer, useFiles } from './Composer.tsx';
import { openFile } from '../lib/viewer.ts';
import { PathMarkdown } from './PathMarkdown.tsx';
import { UserMessage } from './UserMessage.tsx';

function ToolLine({ t, cwd, sessionId }: { t: ToolItem; cwd: string; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const mark = t.state === 'done' ? <span className="ok">✓</span> : t.state === 'failed' ? <span className="ng">✗</span> : <span className="run">…</span>;
  const file = t.paths?.[0];
  return (
    <>
      <div className="tool-line">
        <button
          onClick={() => t.output && setOpen(!open)}
          aria-expanded={t.output ? open : undefined}
          title={t.output ? '出力を表示' : undefined}
          // パスを横に出すときは、ツール名が縮んでパスと重ならないようにする
          style={file ? { flex: 'none' } : undefined}
        >
          {mark}
          <span className="tool-name">{t.name}</span>
          {!file && <span className="ellipsis">{relPath(t.summary, cwd)}</span>}
        </button>
        {/* 対象ファイルのあるツールは、要約のパスをタップするとビュワーで開く */}
        {file && (
          <button className="path-link ellipsis" title="ビュワーで開く" onClick={() => openFile(sessionId, file)}>
            {relPath(t.summary, cwd)}
          </button>
        )}
      </div>
      {open && t.output && <div className="codebox tool-out">{t.output}</div>}
    </>
  );
}

/** ツールの数と種類（例: 「Read 3 · Bash 2」） */
function toolCounts(tools: ToolItem[]): string {
  const m = new Map<string, number>();
  for (const t of tools) m.set(t.name, (m.get(t.name) ?? 0) + 1);
  return [...m].map(([n, c]) => (c > 1 ? `${n} ${c}` : n)).join(' · ');
}

/**
 * 続けて呼ばれたツールを1行にまとめる（デスクトップアプリと同じく、既定は折りたたむ）。
 * 実行中は、いま動いているツールを横に出す。押すと1件ずつの行が開く。
 */
function ToolGroup({ tools, cwd, sessionId }: { tools: ToolItem[]; cwd: string; sessionId: string }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) return <ToolLine t={tools[0]} cwd={cwd} sessionId={sessionId} />;
  const runningTool = [...tools].reverse().find((t) => t.state === 'running');
  const failed = tools.filter((t) => t.state === 'failed').length;
  return (
    <>
      <div className="tool-line tool-group">
        <button onClick={() => setOpen(!open)} aria-expanded={open} title={open ? '折りたたむ' : '1件ずつ表示'}>
          <span className={open ? 'chev open' : 'chev'}>
            <IconChevron size={12} />
          </span>
          {runningTool ? <span className="run">…</span> : failed > 0 ? <span className="ng">✗</span> : <span className="ok">✓</span>}
          <span className="tool-name">ツール {tools.length}件</span>
          <span className="ellipsis">
            {runningTool && !open ? `${runningTool.name} ${relPath(runningTool.summary, cwd)}` : toolCounts(tools)}
            {failed > 0 && !runningTool ? `（失敗 ${failed}）` : ''}
          </span>
        </button>
      </div>
      {open && (
        <div className="tool-children">
          {tools.map((t) => (
            <ToolLine key={t.toolId} t={t} cwd={cwd} sessionId={sessionId} />
          ))}
        </div>
      )}
    </>
  );
}

/** サブエージェントが出した許可要求・質問には、出どころを添える */
function SubOrigin({ requestId }: { requestId: string }) {
  const sub = subOfRequest(useSubCtx(), requestId);
  if (!sub) return null;
  return (
    <div className="note sub-origin ellipsis">
      <span className="sub-icon">◆</span> {subLabel(sub)}（{sub.description}）から
    </div>
  );
}

function ItemView({ item, session, focused, lastUser = false }: { item: Item; session: SessionSummary; focused: boolean; lastUser?: boolean }) {
  switch (item.kind) {
    case 'subagent':
      return <SubagentLine toolId={item.toolId} />;
    case 'user':
      return (
        <UserMessage
          session={session}
          messageId={item.messageId}
          text={item.text}
          at={item.at}
          attachments={item.attachments}
          rewindable={item.rewindable}
          last={lastUser}
        />
      );
    case 'assistant':
      return <PathMarkdown text={item.text} sessionId={session.id} />;
    case 'tools':
      return (
        <div className="tools">
          <ToolGroup tools={item.tools} cwd={session.cwd} sessionId={session.id} />
        </div>
      );
    case 'approval': {
      const pending = session.pendingApprovals.find((a) => a.requestId === item.req.requestId);
      if (pending)
        return (
          <>
            <SubOrigin requestId={pending.requestId} />
            <ApprovalCard session={session} req={pending} focused={focused} />
          </>
        );
      // 許可したものはツールの行で分かるので出さない。拒否・常に許可・取り下げだけ残す
      if (item.decision === 'allow') return null;
      const label = item.decision === 'deny' ? '✗ 拒否' : item.decision === 'allow_session' ? '✓ 常に許可' : '– 取り下げ';
      const target = item.req.command?.split('\n')[0] ?? item.req.changes?.map((c) => c.path).join(', ') ?? item.req.title;
      return (
        <div className="resolved ellipsis">
          {label}: {relPath(target, session.cwd)}
        </div>
      );
    }
    case 'question': {
      const pending = session.pendingQuestions.find((q) => q.requestId === item.req.requestId);
      if (pending)
        return (
          <>
            <SubOrigin requestId={pending.requestId} />
            <QuestionCard session={session} req={pending} />
          </>
        );
      return <div className="resolved ellipsis">? {item.req.prompt.split('\n')[0]}</div>;
    }
    case 'note':
      return <div className="note">— {item.text}</div>;
    case 'error':
      return <div className="note note-error">{item.text}</div>;
  }
}

/** これより低い領域では、サブペインに分けずに会話へ埋め込む */
const MIN_SPLIT_HEIGHT = 360;

/**
 * サブエージェントの一覧と、サブペインの開け閉め。
 * 新しいサブエージェントが動き出したら開いてそのタブにし、全部終わったら畳んでタブの帯だけ残す。
 * full（スマホ）では自動では開かない（画面を奪わないため）。
 */
function useSubagents(session: SessionSummary, events: Parameters<typeof buildSubagents>[0] | undefined, full: boolean) {
  const subs = useMemo(() => {
    const list = buildSubagents(events ?? []);
    // CLI ごと止まったセッションでは、動いたままの記録も止まったものとして出す
    const dead = session.status === 'stopped' || session.status === 'error';
    return dead ? list.map((s): SubagentInfo => (s.state === 'running' ? { ...s, state: 'stopped', progress: undefined } : s)) : list;
  }, [events, session.status]);
  const [ui, setUi] = useState<SubPaneState>({ visible: false, active: null, body: false });
  const known = useRef<{ sessionId: string; ids: Set<string> } | null>(null);
  const anyRunning = subs.some((s) => s.state === 'running');
  const wasRunning = useRef(anyRunning);

  useEffect(() => {
    if (!events) return;
    if (known.current?.sessionId !== session.id) {
      // 開いたときは、動いているものがあればそれを出す
      known.current = { sessionId: session.id, ids: new Set(subs.map((s) => s.toolId)) };
      const running = subs.filter((s) => s.state === 'running');
      setUi(running.length > 0 && !full ? { visible: true, active: running[running.length - 1].toolId, body: true } : { visible: false, active: null, body: false });
      return;
    }
    const ids = known.current.ids;
    const fresh = subs.filter((s) => !ids.has(s.toolId));
    for (const s of fresh) ids.add(s.toolId);
    const started = fresh.filter((s) => s.state === 'running');
    if (started.length > 0 && !full) setUi({ visible: true, active: started[started.length - 1].toolId, body: true });
  }, [subs, events, session.id, full]);

  useEffect(() => {
    if (wasRunning.current && !anyRunning && !full) setUi((u) => ({ ...u, body: false }));
    wasRunning.current = anyRunning;
  }, [anyRunning, full]);

  return { subs, ui, setUi };
}

export function SessionView({
  session,
  focused = true,
  autoRead = true,
  compact = false,
  subLayout = 'split',
}: {
  session: SessionSummary;
  focused?: boolean;
  /** フォーカス中に既読にするか（ペインを閉じて自動でフォーカスが移ったときは、触るまで既読にしない） */
  autoRead?: boolean;
  compact?: boolean;
  /** サブエージェントの出し方（スマホは 'full'） */
  subLayout?: 'split' | 'full';
}) {
  const rawEvents = useStore((s) => s.events[session.id]);
  // 巻き戻した範囲は、会話にもサブエージェントの一覧にも出さない
  const events = useMemo(() => rawEvents && rewoundEvents(rawEvents), [rawEvents]);
  const items = useMemo(() => buildItems(events ?? []), [events]);
  const full = subLayout === 'full';
  const { subs, ui, setUi } = useSubagents(session, events, full);
  const area = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);
  const layout: SubLayout = full ? 'full' : short ? 'inline' : 'split';

  // ペインの高さが足りないときは、サブペインに分けずに会話へ埋め込む
  useEffect(() => {
    const el = area.current;
    if (!el || full) return;
    const ro = new ResizeObserver(() => setShort(el.clientHeight < MIN_SPLIT_HEIGHT));
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);

  const subMap = useMemo(() => new Map(subs.map((s) => [s.toolId, s])), [subs]);
  const select = useCallback((toolId: string) => setUi(() => ({ visible: true, active: toolId, body: true })), [setUi]);
  const waiting = useCallback(
    (sub: SubagentInfo) =>
      session.pendingApprovals.some((a) => sub.toolIds.has(a.requestId)) || session.pendingQuestions.some((q) => sub.toolIds.has(q.requestId)),
    [session.pendingApprovals, session.pendingQuestions],
  );
  const renderItem = useCallback((it: Item) => <ItemView item={it} session={session} focused={focused} />, [session, focused]);
  const subCtx = useMemo(
    () => ({ sessionId: session.id, subs: subMap, layout, select, waiting, renderItem }),
    [session.id, subMap, layout, select, waiting, renderItem],
  );
  const showPane = layout !== 'inline' && ui.visible && subs.length > 0;
  const lastUserKey = useMemo(() => [...items].reverse().find((i) => i.kind === 'user')?.key, [items]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const files = useFiles();
  const [dragging, setDragging] = useState(false);
  const canAttach = useStore((s) => s.info?.agents[session.agent]?.attachments === true) && !session.archived;

  useEffect(() => {
    void loadEvents(session.id);
  }, [session.id]);

  // フォーカス中で画面が見えているときに、未読を既読にする。
  // 「未読にする」の印（markedUnread）も、フォーカスを移して開き直したときや新しい内容が届いたときに外す。
  // 印そのものは依存に入れない（このペインのメニューで「未読にする」を選んだ直後に、すぐ既読へ戻さないため）
  useEffect(() => {
    if (!focused || !autoRead) return;
    if (session.readSeq >= session.lastSeq && !getState().sessions[session.id]?.markedUnread) return;
    const mark = () => {
      if (document.visibilityState === 'visible') void api.read(session.id, session.lastSeq).catch(() => {});
    };
    const t = setTimeout(mark, 400);
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [focused, autoRead, session.id, session.lastSeq, session.readSeq]);

  // 一番下にいるときは、新しい内容に合わせてスクロールする
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // 会話の中に出ていない許可要求・質問（読み込み前など）も必ず表示する
  const shownApprovals = new Set(items.filter((i) => i.kind === 'approval').map((i) => (i.kind === 'approval' ? i.req.requestId : '')));
  const shownQuestions = new Set(items.filter((i) => i.kind === 'question').map((i) => (i.kind === 'question' ? i.req.requestId : '')));

  return (
    <div
      className={dragging ? 'session-drop dragging' : 'session-drop'}
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}
      // ファイルをペインにドロップすると添付する
      onDragOver={(e) => {
        if (!canAttach || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canAttach || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        files.add([...e.dataTransfer.files]);
      }}
    >
      {session.status === 'error' && session.lastError && (
        <div className="banner banner-error">
          <span className="ellipsis" title={session.lastError}>{session.lastError.split('\n')[0]}</span>
        </div>
      )}
      {session.archived && (
        <div className="banner banner-info">
          <span>アーカイブ済みのセッションです（読むことはできます）</span>
          <button className="btn" style={{ height: 28 }} onClick={() => void unarchiveSession(session.id)}>
            アーカイブを解除
          </button>
        </div>
      )}
      {session.status === 'stopped' && !session.archived && (
        <div className="banner banner-info">
          <span>{session.statusReason ?? '停止しています'}</span>
          {session.resumable && (
            <button className="btn" style={{ height: 28 }} onClick={() => run(() => api.resume(session.id))}>
              再開
            </button>
          )}
        </div>
      )}
      <SubCtx.Provider value={subCtx}>
      {/* 本流の会話と、その下のサブペイン（スマホでは全面に重ねる） */}
      <div ref={area} style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div
        ref={scroller}
        style={{ flex: '1 1 auto', overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain' }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="transcript">
          {!events && <div className="note">読み込み中…</div>}
          {items.map((it) => (
            <ItemView key={it.key} item={it} session={session} focused={focused} lastUser={it.key === lastUserKey} />
          ))}
          {session.pendingApprovals
            .filter((a) => !shownApprovals.has(a.requestId))
            .map((a) => (
              <Fragment key={a.requestId}>
                <SubOrigin requestId={a.requestId} />
                <ApprovalCard session={session} req={a} focused={focused} />
              </Fragment>
            ))}
          {session.pendingQuestions
            .filter((q) => !shownQuestions.has(q.requestId))
            .map((q) => (
              <Fragment key={q.requestId}>
                <SubOrigin requestId={q.requestId} />
                <QuestionCard session={session} req={q} />
              </Fragment>
            ))}
          {(session.status === 'running' || session.status === 'starting') && <div className="note st-running">● {session.status === 'starting' ? '起動中…' : '作業中…'}</div>}
        </div>
      </div>
      {showPane && <SubPane subs={subs} ui={ui} setUi={setUi} layout={full ? 'full' : 'split'} area={area} />}
      </div>
      </SubCtx.Provider>
      <Composer session={session} compact={compact} files={files} />
    </div>
  );
}
