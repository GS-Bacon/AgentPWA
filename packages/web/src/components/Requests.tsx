// 許可要求と質問のカード
import { useEffect, useState } from 'react';
import type { ApprovalDecision, FileChange } from '@agentpwa/shared';
import type { ApprovalRequest, QuestionRequest, SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { run } from '../lib/store.ts';
import { elapsed, relPath } from '../lib/format.ts';
import { diffLines } from '../lib/transcript.ts';

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function allowSessionLabel(req: ApprovalRequest): string {
  if (req.kind === 'command' && req.command) {
    const first = req.command.trim().split(/\s+/)[0];
    return `このセッション中は ${first} を常に許可`;
  }
  if (req.kind === 'file_change') return 'このセッション中はファイル変更を常に許可';
  return 'このセッション中は同じ操作を常に許可';
}

export function decide(sessionId: string, requestId: string, decision: ApprovalDecision, note?: string) {
  return run(() => api.action(sessionId, { type: 'approve', requestId, decision, note }));
}

function Files({ changes, open = false, cwd }: { changes: FileChange[]; open?: boolean; cwd: string }) {
  const add = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
  const del = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);
  return (
    <div className="files">
      <div className="files-head">
        <span>ファイル変更 {changes.length}件</span>
        <span>
          <span className="add">+{add}</span> <span className="del">−{del}</span>
        </span>
      </div>
      {changes.map((c) => (
        <details key={c.path} className="file" open={open && changes.length === 1}>
          <summary>
            <span className="ellipsis">{relPath(c.path, cwd)}</span>
            <span style={{ flex: 'none' }}>
              {c.additions !== undefined && <span className="add">+{c.additions}</span>}{' '}
              {c.deletions !== undefined && <span className="del">−{c.deletions}</span>}
            </span>
          </summary>
          {c.diff ? (
            <div className="diff">
              {diffLines(c.diff).map((l, i) => (
                <span key={i} className={l.cls || undefined} style={l.cls ? undefined : { display: 'block' }}>
                  {relPath(l.text, cwd) || ' '}
                </span>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ padding: '4px 0' }}>差分はありません</div>
          )}
        </details>
      ))}
    </div>
  );
}

/** 一覧の行の中に出す小さな許可操作（iPhone の一覧） */
export function ApprovalInline({ session, req }: { session: SessionSummary; req: ApprovalRequest }) {
  const [busy, setBusy] = useState(false);
  const act = async (d: ApprovalDecision) => {
    setBusy(true);
    await decide(session.id, req.requestId, d);
    setBusy(false);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onClick={(e) => e.stopPropagation()}>
      {req.command && (
        <div className="codebox" style={{ maxHeight: 96 }}>
          {req.kind === 'command' ? null : <span className="muted">{req.title} </span>}
          {req.command}
        </div>
      )}
      {req.changes && <Files changes={req.changes} cwd={session.cwd} />}
      <div className="btn-pair">
        <button className="btn btn-lg" disabled={busy} onClick={() => act('deny')}>
          拒否
        </button>
        <button className="btn btn-lg btn-primary" disabled={busy} onClick={() => act('allow')}>
          {session.agent === 'codex' ? '承認' : '許可'}
        </button>
      </div>
    </div>
  );
}

/** 会話の中に出す許可要求のカード */
export function ApprovalCard({ session, req, focused }: { session: SessionSummary; req: ApprovalRequest; focused?: boolean }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const act = async (d: ApprovalDecision, n?: string) => {
    setBusy(true);
    await decide(session.id, req.requestId, d, n);
    setBusy(false);
  };
  const allowLabel = session.agent === 'codex' ? '承認' : '許可';
  return (
    <section className="ask" aria-label={req.title}>
      <div className="ask-head">
        <h3>{req.title}</h3>
        <span className="muted" style={{ fontSize: 12 }}>{elapsed(req.at, now)}</span>
      </div>
      <div className="ask-body">
        {req.command && <div className="codebox">{req.command}</div>}
        {req.changes && req.changes.length > 0 && <Files changes={req.changes} open cwd={session.cwd} />}
        {req.cwd && <p className="mono muted" style={{ fontSize: 11 }}>{req.cwd}</p>}
        {denying ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="sr-only" htmlFor={`deny-${req.requestId}`}>拒否の理由・指示</label>
            <textarea
              id={`deny-${req.requestId}`}
              className="textarea"
              rows={2}
              autoFocus
              placeholder="代わりにどうしてほしいかを書く（空でも可）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="ask-actions">
              <button className="btn btn-lg" disabled={busy} onClick={() => setDenying(false)}>
                戻る
              </button>
              <button className="btn btn-lg btn-danger" disabled={busy} onClick={() => act('deny', note)}>
                拒否して送る
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="btn-pair">
              <button className="btn btn-lg" disabled={busy} onClick={() => setDenying(true)}>
                拒否して指示
              </button>
              <button className="btn btn-lg btn-primary" disabled={busy} onClick={() => act('allow')} data-approve={req.requestId}>
                {allowLabel}
                {focused && <kbd style={{ borderColor: 'rgba(255,255,255,.4)' }}>Enter</kbd>}
              </button>
            </div>
            {req.choices.includes('allow_session') && (
              <button className="btn-link" disabled={busy} onClick={() => act('allow_session')}>
                {allowSessionLabel(req)}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function QuestionCard({ session, req }: { session: SessionSummary; req: QuestionRequest }) {
  const now = useNow();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = async (t: string) => {
    if (!t.trim()) return;
    setBusy(true);
    await run(() => api.action(session.id, { type: 'answer', requestId: req.requestId, text: t }));
    setBusy(false);
  };
  return (
    <section className="ask ask-q" aria-label="質問">
      <div className="ask-head">
        <h3>質問</h3>
        <span className="muted" style={{ fontSize: 12 }}>{elapsed(req.at, now)}</span>
      </div>
      <div className="ask-body">
        <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{req.prompt}</p>
        {req.options && req.options.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {req.options.map((o) => (
              <button key={o} className="btn btn-lg" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => answer(o)}>
                {o}
              </button>
            ))}
          </div>
        )}
        <form
          className="composer-row"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(text);
          }}
        >
          <label className="sr-only" htmlFor={`ans-${req.requestId}`}>回答</label>
          <input id={`ans-${req.requestId}`} className="input" style={{ flex: 1, height: 40 }} placeholder="自由に回答…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary" style={{ height: 40 }} disabled={busy || !text.trim()}>
            回答
          </button>
        </form>
      </div>
    </section>
  );
}
