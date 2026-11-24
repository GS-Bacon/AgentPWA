// セッションの中身（会話・許可要求・入力欄）。iPhone の詳細画面と、iPad / Web のペインで共通に使う。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { loadEvents, run, useStore } from '../lib/store.ts';
import { relPath } from '../lib/format.ts';
import { unarchiveSession } from '../lib/sessionActions.ts';
import { buildItems, type Item, type ToolItem } from '../lib/transcript.ts';
import { ApprovalCard, QuestionCard } from './Requests.tsx';
import { IconSend, IconStop } from './Icons.tsx';
import { PermissionButton, usePermissionSwitch } from './PermissionMode.tsx';
import { ModelButton } from './ModelSettings.tsx';
import { openFile } from '../lib/viewer.ts';
import { PathMarkdown } from './PathMarkdown.tsx';

function ToolLine({ t, cwd, sessionId }: { t: ToolItem; cwd: string; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const mark = t.state === 'done' ? <span className="ok">✓</span> : t.state === 'failed' ? <span className="ng">✗</span> : <span className="run">…</span>;
  const file = t.paths?.[0];
  return (
    <>
      <div className="tool-line">
        <button onClick={() => t.output && setOpen(!open)} aria-expanded={t.output ? open : undefined} title={t.output ? '出力を表示' : undefined}>
          {mark}
          <span style={{ color: 'var(--fg)' }}>{t.name}</span>
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

function ItemView({ item, session, focused }: { item: Item; session: SessionSummary; focused: boolean }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg-user">{item.text}</div>;
    case 'assistant':
      return <PathMarkdown text={item.text} sessionId={session.id} />;
    case 'tools':
      return (
        <div className="tools">
          {item.tools.map((t) => (
            <ToolLine key={t.toolId} t={t} cwd={session.cwd} sessionId={session.id} />
          ))}
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

function Composer({ session, compact }: { session: SessionSummary; compact?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = session.status === 'running' || session.status === 'starting' || session.status === 'waiting_approval' || session.status === 'waiting_input';
  const stopped = !session.live && (session.status === 'stopped' || session.status === 'error' || session.status === 'idle');
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const sw = usePermissionSwitch(session);
  const archived = session.archived;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`;
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await run(() => api.action(session.id, { type: 'send', text: t }));
    setBusy(false);
    if (ok) setText('');
  };
  const interrupt = () => run(() => api.action(session.id, { type: 'interrupt' }));

  const placeholder = archived
    ? 'アーカイブを解除すると送信できます'
    : stopped ? (session.resumable ? '送信するとセッションを再開します…' : '送信すると新しく始めます…') : running ? '実行中も追加の指示を送れます…' : '指示を入力…';
  return (
    <footer className="composer">
      {!compact && (
        <div className="composer-meta">
          <ModelButton session={session} disabled={archived} />
        </div>
      )}
      <div className="composer-row">
        <PermissionButton sw={sw} disabled={archived} showShortcut={!isTouch} />
        <label className="sr-only" htmlFor={`c-${session.id}`}>指示を入力</label>
        <textarea
          id={`c-${session.id}`}
          ref={ref}
          className="textarea"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={archived}
          style={{ fontSize: isTouch ? 16 : 14 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Shift+Tab で権限モードを順に切り替える（「すべて自動」は確認が要るので巡回に入れない）
            if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sw.cycle();
              return;
            }
            // デスクトップは Enter で送信（Shift+Enter で改行）。iPhone / iPad のソフトキーボードでは改行
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {running && !text.trim() && !archived ? (
          <button className="btn btn-icon" style={{ height: 40, width: 40 }} aria-label="中断" title="中断" onClick={interrupt}>
            <IconStop size={14} />
          </button>
        ) : (
          <button className="btn btn-primary btn-icon" style={{ height: 40, width: 40 }} aria-label="送信" disabled={!text.trim() || busy || archived} onClick={send}>
            <IconSend size={16} />
          </button>
        )}
      </div>
    </footer>
  );
}

export function SessionView({ session, focused = true, compact = false }: { session: SessionSummary; focused?: boolean; compact?: boolean }) {
  const events = useStore((s) => s.events[session.id]);
  const items = useMemo(() => buildItems(events ?? []), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

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
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
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
      <Composer session={session} compact={compact} />
    </div>
  );
}
