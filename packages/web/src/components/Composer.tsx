// 入力欄: 指示の送信、ファイルの添付（選ぶ・貼り付け・ドロップ）、スラッシュコマンドの補完。
// 振る舞いは Claude のデスクトップアプリに合わせる（/ で補完が出る、画像は貼り付けで添付できる）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { clearDraft, run, showToast, useStore } from '../lib/store.ts';
import { isRunning } from '../lib/format.ts';
import { filterCommands, slashQuery, useCommands } from '../lib/commands.ts';
import { formatBytes, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, nameForPasted, releasePending, toAttachment, toPending, type PendingFile } from '../lib/attachments.ts';
import { IconClose, IconFile, IconPaperclip, IconSend, IconStop } from './Icons.tsx';
import { PermissionButton, usePermissionSwitch } from './PermissionMode.tsx';
import { ModelButton } from './ModelSettings.tsx';

/** 添付ファイルの一覧（SessionView が持ち、ペインへのドロップでも足せるようにする） */
export interface FilesState {
  files: PendingFile[];
  add: (files: File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export function useFiles(): FilesState {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const ref = useRef(files);
  ref.current = files;
  // 画面を閉じたらサムネイルを片付ける
  useEffect(() => () => ref.current.forEach(releasePending), []);
  return {
    files,
    add: (list) => {
      if (list.length === 0) return;
      setFiles((cur) => {
        const room = MAX_ATTACHMENTS - cur.length;
        if (list.length > room) showToast(`添付できるファイルは ${MAX_ATTACHMENTS} 件までです`);
        return [...cur, ...list.slice(0, Math.max(0, room)).map(toPending)];
      });
    },
    remove: (id) =>
      setFiles((cur) => {
        const f = cur.find((x) => x.id === id);
        if (f) releasePending(f);
        return cur.filter((x) => x.id !== id);
      }),
    clear: () =>
      setFiles((cur) => {
        cur.forEach(releasePending);
        return [];
      }),
  };
}

function FileChips({ files, onRemove, disabled }: { files: PendingFile[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (files.length === 0) return null;
  return (
    <div className="attach-list">
      {files.map((f) => (
        <div key={f.id} className="attach-chip" title={f.file.name}>
          {f.preview ? <img src={f.preview} alt="" /> : <span className="attach-icon"><IconFile size={14} /></span>}
          <span className="ellipsis">{f.file.name}</span>
          <span className="muted">{formatBytes(f.file.size)}</span>
          <button className="btn-x" aria-label={`${f.file.name} を外す`} disabled={disabled} onClick={() => onRemove(f.id)}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ session, compact, files }: { session: SessionSummary; compact?: boolean; files: FilesState }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = isRunning(session);
  const stopped = !session.live && (session.status === 'stopped' || session.status === 'error' || session.status === 'idle');
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const sw = usePermissionSwitch(session);
  const archived = session.archived;
  const features = useStore((s) => s.info?.agents[session.agent]);
  const canAttach = features?.attachments === true;

  // 巻き戻した発言などを入力欄に入れる（store の setDraft）
  const draft = useStore((s) => (s.draft?.sessionId === session.id ? s.draft : null));
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(draft.text.length, draft.text.length);
    }
    clearDraft(draft.n);
  }, [draft]);

  // ---- スラッシュコマンドの補完 ----
  const query = slashQuery(text);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const menuWanted = features?.commands === true && query !== null && dismissed !== text && !archived;
  const commands = useCommands(session.id, menuWanted);
  const matches = menuWanted ? filterCommands(commands.list, query ?? '') : [];
  const menuOpen = menuWanted && (matches.length > 0 || commands.loading || !!commands.error);
  const [sel, setSel] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    menuRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const complete = (name: string) => {
    setText(`/${name} `);
    ref.current?.focus();
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`;
  }, [text]);

  const canSend = (!!text.trim() || files.files.length > 0) && !busy && !archived;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    const ok = await run(async () => {
      const attachments = await Promise.all(files.files.map((f) => toAttachment(f.file)));
      const total = attachments.reduce((n, a) => n + Math.floor((a.data.length * 3) / 4), 0);
      if (total > MAX_TOTAL_BYTES) throw new Error(`添付ファイルは合計 ${MAX_TOTAL_BYTES / 1024 / 1024}MB までです（いま ${formatBytes(total)}）`);
      return api.action(session.id, attachments.length > 0 ? { type: 'send', text, attachments } : { type: 'send', text: text.trim() });
    });
    setBusy(false);
    if (ok) {
      setText('');
      files.clear();
    }
  };
  const interrupt = () => run(() => api.action(session.id, { type: 'interrupt' }));

  const placeholder = archived
    ? 'アーカイブを解除すると送信できます'
    : stopped
      ? session.resumable
        ? '送信するとセッションを再開します…'
        : '送信すると新しく始めます…'
      : running
        ? '実行中も追加の指示を送れます…'
        : features?.commands && !isTouch
          ? '指示を入力（/ でコマンド）…'
          : '指示を入力…';

  return (
    <footer className="composer">
      {menuOpen && (
        <div className="slash-menu" role="listbox" aria-label="コマンド" ref={menuRef}>
          {matches.length === 0 && <div className="slash-empty">{commands.loading ? 'コマンドを読み込み中…' : commands.error ?? '一致するコマンドはありません'}</div>}
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              data-i={i}
              aria-selected={i === sel}
              className={i === sel ? 'slash-item sel' : 'slash-item'}
              // 押した瞬間に入力欄のフォーカスが外れないようにする
              onMouseDown={(e) => e.preventDefault()}
              // 止まったマウスの下に候補が開いたときに選ばれないよう、動かしたときだけ選ぶ
              onMouseMove={() => {
                if (sel !== i) setSel(i);
              }}
              onClick={() => complete(c.name)}
            >
              <span className="slash-name">/{c.name}</span>
              {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
              {c.description && <span className="slash-desc ellipsis">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      {!compact && (
        <div className="composer-meta">
          <ModelButton session={session} disabled={archived} />
        </div>
      )}
      <FileChips files={files.files} onRemove={files.remove} disabled={busy} />
      <div className="composer-row">
        <PermissionButton sw={sw} disabled={archived} showShortcut={!isTouch} />
        {canAttach && (
          <>
            <button className="btn btn-ghost btn-icon" style={{ height: 40, width: 32 }} aria-label="ファイルを添付" title="ファイルを添付（貼り付け・ドロップでも添付できます）" disabled={archived || busy} onClick={() => fileInput.current?.click()}>
              <IconPaperclip size={16} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                files.add([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </>
        )}
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
          aria-autocomplete={features?.commands ? 'list' : undefined}
          aria-expanded={features?.commands ? menuOpen : undefined}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // スクリーンショットなどの画像・ファイルを貼り付けたら添付にする（文字だけなら普通に貼り付け）
            if (!canAttach) return;
            const pasted = [...e.clipboardData.files];
            if (pasted.length === 0) return;
            e.preventDefault();
            files.add(pasted.map(nameForPasted));
          }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing;
            if (menuOpen && matches.length > 0 && !composing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                setSel((i) => (i + d + matches.length) % matches.length);
                return;
              }
              const picked = matches[Math.min(sel, matches.length - 1)];
              // Tab は補完。Enter も補完するが、打ち終わった名前と同じなら、そのまま送信する
              if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && picked.name !== query)) {
                e.preventDefault();
                complete(picked.name);
                return;
              }
            }
            if (menuOpen && e.key === 'Escape') {
              e.preventDefault();
              setDismissed(text);
              return;
            }
            // Shift+Tab で権限モードを順に切り替える（「すべて自動」は確認が要るので巡回に入れない）
            if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !composing) {
              e.preventDefault();
              sw.cycle();
              return;
            }
            // デスクトップは Enter で送信（Shift+Enter で改行）。iPhone / iPad のソフトキーボードでは改行
            if (e.key === 'Enter' && !e.shiftKey && !composing && !isTouch) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {running && !text.trim() && files.files.length === 0 && !archived ? (
          <button className="btn btn-icon" style={{ height: 40, width: 40 }} aria-label="中断" title="中断" onClick={interrupt}>
            <IconStop size={14} />
          </button>
        ) : (
          <button className="btn btn-primary btn-icon" style={{ height: 40, width: 40 }} aria-label="送信" disabled={!canSend} onClick={send}>
            <IconSend size={16} />
          </button>
        )}
      </div>
    </footer>
  );
}
