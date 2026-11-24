// 送ったメッセージ（ユーザーの発言）と、その下の操作（フォーク・巻き戻し・編集・コピー）。
// 並びと振る舞いは Claude のデスクトップアプリに合わせる:
// - 発言の下の右端に、送った時刻と操作のアイコンを出す（マウスでは発言に重ねたときだけ）
// - 編集: 発言がその場で入力欄になり、送信すると、この発言から後の会話を取り消して送り直す
// - 巻き戻し: 戻すもの（会話とコード / 会話だけ / コードだけ）を選ぶダイアログを出す。会話を戻したら発言を入力欄に戻す
// - フォーク: このターンまでの会話を引き継ぐ新しいセッションを作って開く
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttachmentInfo, RewindRestore } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { openSession, run, setDraft, showInfo, showToast, useStore } from '../lib/store.ts';
import { elapsed } from '../lib/format.ts';
import { isActive } from '../lib/sessionActions.ts';
import { formatBytes } from '../lib/attachments.ts';
import { copyText } from './PathMarkdown.tsx';
import { IconCheck, IconCopy, IconFile, IconFork, IconPencil, IconRewind } from './Icons.tsx';

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

export interface UserMessageProps {
  session: SessionSummary;
  messageId: string;
  text: string;
  at: string;
  attachments?: AttachmentInfo[];
  rewindable: boolean;
  /** 会話の最後の発言か（まだ終わっていないターンからはフォークできない） */
  last: boolean;
}

const RESTORE_OPTIONS: { value: RewindRestore; label: string; note: string }[] = [
  { value: 'both', label: '会話とコードを戻す', note: 'この発言から後の会話と、ファイルの変更を取り消します' },
  { value: 'conversation', label: '会話だけ戻す', note: 'ファイルはいまのまま残します' },
  { value: 'code', label: 'コードだけ戻す', note: '会話は残し、ファイルをこの発言を送る前の状態に戻します' },
];

/** 巻き戻しのダイアログ。決めたら restore、やめたら null で閉じる */
function RewindDialog({ text, onClose }: { text: string; onClose: (restore: RewindRestore | null) => void }) {
  const [restore, setRestore] = useState<RewindRestore>('both');
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" style={{ zIndex: 70 }} onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rewind-title" style={{ width: 'min(460px, 100%)' }}>
        <div className="dialog-head" style={{ padding: '12px 16px' }}>
          <h2 id="rewind-title">この発言まで巻き戻す</h2>
        </div>
        <div className="dialog-body" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="rewind-quote">{text}</div>
          <div className="rewind-options" role="radiogroup" aria-label="戻すもの">
            {RESTORE_OPTIONS.map((o) => (
              <label key={o.value} className={restore === o.value ? 'rewind-option sel' : 'rewind-option'}>
                <input type="radio" name="rewind-restore" value={o.value} checked={restore === o.value} onChange={() => setRestore(o.value)} />
                <span>
                  <span className="rewind-label">{o.label}</span>
                  <span className="rewind-note">{o.note}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {restore !== 'code' && '戻した発言は入力欄に入ります。'}
            {restore !== 'conversation' && 'コードは Claude がファイル編集のツールで変えた分だけ戻ります（コマンドで変えたファイルは戻りません）。'}
          </p>
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={() => onClose(null)}>
            キャンセル
          </button>
          <button ref={okRef} className="btn btn-primary" onClick={() => onClose(restore)}>
            巻き戻す
          </button>
        </div>
      </div>
    </div>
  );
}

/** 発言をその場で直す入力欄。送信で onSubmit、Esc かキャンセルで onCancel */
function EditBox({ initial, busy, onSubmit, onCancel }: { initial: string; busy: boolean; onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const canSend = !!text.trim() && !busy;
  return (
    <div className="msg-edit">
      <textarea
        ref={ref}
        className="textarea"
        value={text}
        aria-label="発言を編集"
        disabled={busy}
        style={{ fontSize: isTouch ? 16 : 14 }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
            e.preventDefault();
            if (canSend) onSubmit(text.trim());
          }
        }}
      />
      <div className="msg-edit-foot">
        <span className="muted ellipsis" style={{ fontSize: 12, flex: '1 1 auto' }}>
          この発言から後の会話を取り消して送り直します
        </span>
        <button className="btn btn-sm" onClick={onCancel} disabled={busy}>
          キャンセル
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => onSubmit(text.trim())} disabled={!canSend}>
          送信
        </button>
      </div>
    </div>
  );
}

function ActionButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="msg-action" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function UserMessage({ session, messageId, text, at, attachments, rewindable, last }: UserMessageProps) {
  const features = useStore((s) => s.info?.agents[session.agent]);
  const [mode, setMode] = useState<'view' | 'edit' | 'rewind'>('view');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // 時刻の表示を1分ごとに更新する
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const active = isActive(session);
  const canChange = rewindable && !session.archived;
  const canRewind = canChange && features?.rewind === true;
  const canFork = canChange && features?.fork === true;
  const busyNote = '作業中は使えません（中断してから操作してください）';

  const copy = async () => {
    if (await copyText(text)) setCopied(true);
    else showToast('コピーできませんでした');
  };

  const fork = async () => {
    setBusy(true);
    const s = await run(() => api.fork(session.id, messageId));
    setBusy(false);
    if (s) openSession(s.id);
  };

  const rewind = async (restore: RewindRestore) => {
    setMode('view');
    setBusy(true);
    const ok = await run(() => api.action(session.id, { type: 'rewind', messageId, restore }));
    setBusy(false);
    if (!ok) return;
    if (restore === 'code') showInfo('ファイルをこの発言を送る前の状態に戻しました');
    // 会話を戻したら、戻した発言を入力欄に入れる（CLI の /rewind と同じ）
    else setDraft(session.id, text);
  };

  const submitEdit = async (next: string) => {
    setBusy(true);
    const rewound = await run(() => api.action(session.id, { type: 'rewind', messageId, restore: 'conversation' }));
    if (!rewound) {
      setBusy(false);
      return;
    }
    // 巻き戻した後に送れなかったら、直した文を入力欄に残す（巻き戻しの後はこの発言は消えている）
    const sent = await run(() => api.action(session.id, { type: 'send', text: next }));
    if (!sent) setDraft(session.id, next);
    setBusy(false);
    setMode('view');
  };

  return (
    <div className="msg-user-wrap">
      {mode === 'edit' ? (
        <EditBox initial={text} busy={busy} onSubmit={(t) => void submitEdit(t)} onCancel={() => setMode('view')} />
      ) : (
        <div className="msg-user">
          {text}
          {attachments && attachments.length > 0 && <AttachmentList items={attachments} />}
        </div>
      )}
      {mode !== 'edit' && (
        <div className="msg-actions">
          <span className="msg-time" title={new Date(at).toLocaleString()}>
            {elapsed(at)}前
          </span>
          {canFork && (
            <ActionButton label={last && active ? 'このターンが終わるとフォークできます' : 'ここからフォーク'} disabled={busy || (last && active)} onClick={() => void fork()}>
              <IconFork size={14} />
            </ActionButton>
          )}
          {canRewind && (
            <ActionButton label={active ? busyNote : 'ここまで巻き戻す'} disabled={busy || active} onClick={() => setMode('rewind')}>
              <IconRewind size={14} />
            </ActionButton>
          )}
          {canRewind && (
            <ActionButton label={active ? busyNote : '編集'} disabled={busy || active} onClick={() => setMode('edit')}>
              <IconPencil size={14} />
            </ActionButton>
          )}
          <ActionButton label={copied ? 'コピーしました' : 'コピー'} onClick={() => void copy()}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionButton>
        </div>
      )}
      {mode === 'rewind' && <RewindDialog text={text} onClose={(r) => (r ? void rewind(r) : setMode('view'))} />}
    </div>
  );
}
