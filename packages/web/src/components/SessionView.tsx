// セッションの中身（会話・許可要求・入力欄）。iPhone の詳細画面と、iPad / Web のペインで共通に使う。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentInfo } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { loadEvents, run, useStore } from '../lib/store.ts';
import { relPath } from '../lib/format.ts';
import { unarchiveSession } from '../lib/sessionActions.ts';
import { buildItems, type Item, type ToolItem } from '../lib/transcript.ts';
import { ApprovalCard, QuestionCard } from './Requests.tsx';
import { IconChevron, IconFile } from './Icons.tsx';
import { Composer, useFiles } from './Composer.tsx';
import { formatBytes } from '../lib/attachments.ts';
import { openFile } from '../lib/viewer.ts';
import { PathMarkdown } from './PathMarkdown.tsx';

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

function AttachmentList({ items }: { items: AttachmentInfo[] }) {
  return (
    <div className="msg-attach">
      {items.map((a, i) => (
        <span key={i} className="msg-attach-item" title={`${a.name}（${a.mimeType}）`}>
          <IconFile size={12} />
          <span className="ellipsis">{a.name}</span>
          <span className="muted">{formatBytes(a.size)}</span>
        </span>
      ))}
    </div>
  );
}

function ItemView({ item, session, focused }: { item: Item; session: SessionSummary; focused: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {item.text}
          {item.attachments && item.attachments.length > 0 && <AttachmentList items={item.attachments} />}
        </div>
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
      if (pending) return <ApprovalCard session={session} req={pending} focused={focused} />;
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
      if (pending) return <QuestionCard session={session} req={pending} />;
      return <div className="resolved ellipsis">? {item.req.prompt.split('\n')[0]}</div>;
    }
    case 'note':
      return <div className="note">— {item.text}</div>;
    case 'error':
      return <div className="note note-error">{item.text}</div>;
  }
}

export function SessionView({ session, focused = true, compact = false }: { session: SessionSummary; focused?: boolean; compact?: boolean }) {
  const events = useStore((s) => s.events[session.id]);
  const items = useMemo(() => buildItems(events ?? []), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const files = useFiles();
  const [dragging, setDragging] = useState(false);
  const canAttach = useStore((s) => s.info?.agents[session.agent]?.attachments === true) && !session.archived;

  useEffect(() => {
    void loadEvents(session.id);
  }, [session.id]);

  // フォーカス中で画面が見えているときに、未読を既読にする
  useEffect(() => {
    if (!focused || session.readSeq >= session.lastSeq) return;
    const mark = () => {
      if (document.visibilityState === 'visible') void api.read(session.id, session.lastSeq).catch(() => {});
    };
    const t = setTimeout(mark, 400);
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [focused, session.id, session.lastSeq, session.readSeq]);

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
            <ItemView key={it.key} item={it} session={session} focused={focused} />
          ))}
          {session.pendingApprovals
            .filter((a) => !shownApprovals.has(a.requestId))
            .map((a) => (
              <ApprovalCard key={a.requestId} session={session} req={a} focused={focused} />
            ))}
          {session.pendingQuestions
            .filter((q) => !shownQuestions.has(q.requestId))
            .map((q) => (
              <QuestionCard key={q.requestId} session={session} req={q} />
            ))}
          {(session.status === 'running' || session.status === 'starting') && <div className="note st-running">● {session.status === 'starting' ? '起動中…' : '作業中…'}</div>}
        </div>
      </div>
      <Composer session={session} compact={compact} files={files} />
    </div>
  );
}
