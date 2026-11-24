// 許可要求と質問のカード
import { useEffect, useState } from 'react';
import type { ApprovalDecision, FileChange, QuestionItem } from '@agentpwa/shared';
import type { ApprovalRequest, QuestionRequest, SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { run } from '../lib/store.ts';
import { elapsed, relPath } from '../lib/format.ts';
import { diffLines } from '../lib/transcript.ts';
import { openFile } from '../lib/viewer.ts';

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

function Files({ changes, open = false, cwd, sessionId }: { changes: FileChange[]; open?: boolean; cwd: string; sessionId: string }) {
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
            <span style={{ flex: 'none', display: 'inline-flex', gap: 8, alignItems: 'baseline' }}>
              {/* いまのファイルをビュワーで開く（新しく作るファイルは、まだ無いので出さない） */}
              {c.kind !== 'add' && (
                <button
                  className="path-link"
                  title="いまのファイルをビュワーで開く"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openFile(sessionId, c.path);
                  }}
                >
                  開く
                </button>
              )}
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
      {req.changes && <Files changes={req.changes} cwd={session.cwd} sessionId={session.id} />}
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
        {req.changes && req.changes.length > 0 && <Files changes={req.changes} open cwd={session.cwd} sessionId={session.id} />}
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

/** 問いへの回答（選んだ選択肢と、自由記述）。 */
type Draft = { picked: string[]; other: string };

function draftAnswer(q: QuestionItem, d: Draft): string {
  const other = d.other.trim();
  if (q.multiSelect) return [...d.picked, ...(other ? [other] : [])].join(', ');
  return other || d.picked[0] || '';
}

export function QuestionCard({ session, req }: { session: SessionSummary; req: QuestionRequest }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  // v8 より前の Driver（questions なし）は、prompt と options の1問として扱い、answers は送らない
  const structured = !!req.questions && req.questions.length > 0;
  const questions: QuestionItem[] = structured
    ? req.questions!
    : [{ question: req.prompt, options: (req.options ?? []).map((label) => ({ label })) }];
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ picked: [], other: '' })));
  const setDraft = (i: number, d: Draft) => setDrafts((ds) => ds.map((x, j) => (j === i ? d : x)));

  const submit = async (answers: string[]) => {
    if (answers.some((a) => !a.trim())) return;
    const text = questions.length === 1 ? answers[0] : questions.map((q, i) => `${q.question}\n→ ${answers[i]}`).join('\n');
    setBusy(true);
    await run(() => api.action(session.id, structured ? { type: 'answer', requestId: req.requestId, text, answers } : { type: 'answer', requestId: req.requestId, text }));
    setBusy(false);
  };

  // 単一選択の1問だけなら、選択肢を押した時点で答える（従来どおり）
  const quick = questions.length === 1 && !questions[0].multiSelect;
  const answers = questions.map((q, i) => draftAnswer(q, drafts[i]));
  const ready = answers.every((a) => a.trim());

  // 複数の問いは1問ずつ出し、「次へ」「戻る」と上の段の見出しで行き来する（Claude デスクトップアプリと同じ流れ）
  const [step, setStep] = useState(0);
  const multi = questions.length > 1;
  const last = step === questions.length - 1;
  const go = (i: number) => setStep(Math.max(0, Math.min(questions.length - 1, i)));

  const q = questions[step];
  const d = drafts[step];
  const toggle = (label: string) => {
    if (quick) return void submit([label]);
    if (q.multiSelect) {
      setDraft(step, { ...d, picked: d.picked.includes(label) ? d.picked.filter((p) => p !== label) : [...d.picked, label] });
      return;
    }
    const off = d.picked[0] === label;
    setDraft(step, { picked: off ? [] : [label], other: '' });
    // 単一選択は、選んだら次の問いへ進む（最後の問いでは進まず、回答ボタンで送る）
    if (!off && !last) go(step + 1);
  };
  const inputId = `ans-${req.requestId}-${step}`;

  return (
    <section className="ask ask-q" aria-label="質問">
      <div className="ask-head">
        <h3>{multi ? `質問 ${step + 1} / ${questions.length}` : '質問'}</h3>
        <span className="muted" style={{ fontSize: 12 }}>{elapsed(req.at, now)}</span>
      </div>
      {multi && (
        <nav className="q-steps" aria-label="問いの一覧">
          {questions.map((x, i) => (
            <button
              key={i}
              type="button"
              className="q-step"
              aria-current={i === step ? 'step' : undefined}
              data-done={answers[i].trim() ? 'true' : undefined}
              onClick={() => go(i)}
            >
              <span aria-hidden="true">{answers[i].trim() ? '✓' : i + 1}</span>
              <span className="ellipsis">{x.header || `質問 ${i + 1}`}</span>
            </button>
          ))}
        </nav>
      )}
      <form
        className="ask-body"
        onSubmit={(e) => {
          e.preventDefault();
          // Enter: 途中の問いなら次へ、最後の問いなら送る
          if (!last) go(step + 1);
          else void submit(answers);
        }}
      >
        <fieldset key={step} className="q-item">
          <legend className="sr-only">{q.header || q.question}</legend>
          {((!multi && q.header) || q.multiSelect) && (
            <div className="q-meta">
              {!multi && q.header && <span className="q-header">{q.header}</span>}
              {q.multiSelect && <span className="muted">複数選択できます</span>}
            </div>
          )}
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{q.question}</p>
          {q.options.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.options.map((o) => {
                const on = d.picked.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    className="btn q-opt"
                    aria-pressed={quick ? undefined : on}
                    disabled={busy}
                    onClick={() => toggle(o.label)}
                  >
                    <span className="q-opt-label">
                      {!quick && <span className="q-mark" aria-hidden="true">{q.multiSelect ? (on ? '☑' : '☐') : on ? '●' : '○'}</span>}
                      {o.label}
                    </span>
                    {o.description && <span className="q-opt-desc">{o.description}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <label className="sr-only" htmlFor={inputId}>
            {q.options.length > 0 ? 'その他の回答' : '回答'}
          </label>
          <input
            id={inputId}
            className="input"
            style={{ height: 40 }}
            placeholder={q.options.length > 0 ? (q.multiSelect ? 'その他（自由記述・選択に追加）…' : 'その他（自由記述）…') : '自由に回答…'}
            value={d.other}
            disabled={busy}
            onChange={(e) => setDraft(step, { picked: q.multiSelect || !e.target.value ? d.picked : [], other: e.target.value })}
          />
        </fieldset>
        <div className="ask-actions" style={{ justifyContent: 'flex-end' }}>
          {multi && last && !ready && (
            <span className="muted" style={{ fontSize: 12 }}>
              未回答 {answers.filter((a) => !a.trim()).length} 問
            </span>
          )}
          {multi && step > 0 && (
            <button type="button" className="btn" style={{ height: 40 }} disabled={busy} onClick={() => go(step - 1)}>
              戻る
            </button>
          )}
          {multi && !last ? (
            <button type="submit" className="btn btn-primary" style={{ height: 40 }} disabled={busy}>
              次へ
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" style={{ height: 40 }} disabled={busy || !ready}>
              回答
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
