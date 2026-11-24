// 小さな共通部品
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentKind } from '@agentpwa/shared';
import type { SessionSummary, UsageInfo } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { dismissToast, run, useStore } from '../lib/store.ts';
import { archiveSession, deleteSession, unarchiveSession } from '../lib/sessionActions.ts';
import { elapsed, statusView } from '../lib/format.ts';
import { IconMore } from './Icons.tsx';

export function StatusLabel({ s, withTime, now }: { s: SessionSummary; withTime?: boolean; now?: number }) {
  const v = statusView(s);
  return (
    <span className={`st ${v.cls}`}>
      ● {v.label}
      {withTime && s.rank <= 3 ? ` ${elapsed(s.statusSince, now)}` : ''}
    </span>
  );
}

/** 「すべて自動」のセッションの印（一覧の行とペインのヘッダー） */
export function AutoWarn({ s }: { s: Pick<SessionSummary, 'permissionMode'> }) {
  if (s.permissionMode !== 'full_auto') return null;
  return (
    <span className="auto-warn" title="権限モード: すべて自動（確認せずに実行します）">
      ⚠ 自動
    </span>
  );
}

// ---- メニュー ----

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** 文字をエラー色にする（削除・停止） */
  danger?: boolean;
}

/** セッションの操作（ペインのヘッダーの「⋯」と、一覧の行の右クリック・長押しで共通） */
export function sessionMenuItems(s: SessionSummary): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: '名前を変更',
      onClick: () => {
        const t = window.prompt('セッションの名前', s.title);
        if (t && t.trim()) void run(() => api.update(s.id, { title: t }));
      },
    },
  ];
  if (!s.archived) {
    items.push(
      s.live
        ? { label: '停止', onClick: () => void run(() => api.stop(s.id)), danger: true }
        : { label: s.resumable ? '再開' : '起動', onClick: () => void run(() => api.resume(s.id)) },
    );
  }
  items.push(
    s.archived ? { label: 'アーカイブを解除', onClick: () => void unarchiveSession(s.id) } : { label: 'アーカイブ', onClick: () => void archiveSession(s.id) },
    { label: '削除', onClick: () => void deleteSession(s.id), danger: true },
  );
  return items;
}

function MenuButtons({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? 'danger' : undefined}
          onClick={() => {
            close();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </>
  );
}

/** 外側を押す・Esc で閉じる */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

export function SessionMenu({ s, extra }: { s: SessionSummary; extra?: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn btn-ghost btn-icon" aria-label="メニュー" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} style={{ width: 36, height: 36 }}>
        <IconMore />
      </button>
      {open && (
        <div className="menu" role="menu">
          <MenuButtons items={[...(extra ?? []), ...sessionMenuItems(s)]} close={close} />
        </div>
      )}
    </div>
  );
}

/** 右クリック・長押しで出すメニュー（押した位置に出し、画面からはみ出さないようにずらす） */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useDismiss(true, ref, onClose);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    el.querySelector('button')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu menu-fixed" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      <MenuButtons items={items} close={onClose} />
    </div>
  );
}

/**
 * タッチの長押し（iPad）。押したまま動かさずに一定時間たったら onLongPress を呼び、そのあとの click は捨てる。
 * マウスは右クリック（onContextMenu）で扱う。
 */
export function useLongPress(onLongPress: (x: number, y: number) => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (e.pointerType !== 'touch') return;
      start.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress(start.current.x, start.current.y);
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (timer.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}

// ---- その他 ----

export function UsageBars({ usage }: { usage: UsageInfo[] }) {
  if (usage.length === 0) return null;
  return (
    <div className="usage">
      {usage.map((u) => (
        <div key={u.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="usage-row">
            <span>{u.label}</span>
            <span style={{ color: 'var(--fg)' }}>{u.percent !== undefined ? `${u.percent}%` : '—'}</span>
          </div>
          <div className={`usage-bar${(u.percent ?? 0) >= 80 ? ' hi' : ''}`}>
            <div style={{ width: `${Math.min(100, u.percent ?? 0)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConnState() {
  const connected = useStore((s) => s.connected);
  if (connected) return null;
  return <span className="conn conn-off">● Hub に接続していません</span>;
}

/** 画面下の通知。「元に戻す」などのボタンを添えられる */
export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  const action = toast.action;
  return (
    <div role="status" className={`toast${toast.tone === 'error' ? ' toast-error' : ''}`}>
      <span style={{ minWidth: 0 }}>{toast.text}</span>
      {action && (
        <button
          className="btn-link"
          style={{ flex: 'none' }}
          onClick={() => {
            dismissToast();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** 確認ダイアログ（askConfirm で出す）。削除などの確定ボタンはエラー色の文字にする */
export function ConfirmHost() {
  const c = useStore((s) => s.confirm);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!c) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') c.resolve(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [c]);
  if (!c) return null;
  return (
    <div className="overlay" style={{ zIndex: 70 }} onMouseDown={(e) => e.target === e.currentTarget && c.resolve(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" style={{ width: 'min(420px, 100%)' }}>
        <div className="dialog-head" style={{ padding: '12px 16px' }}>
          <h2 id="confirm-title" className="ellipsis">{c.title}</h2>
        </div>
        <div className="dialog-body" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {c.body.map((t) => (
            <p key={t} style={{ fontSize: 14 }}>{t}</p>
          ))}
        </div>
        <div className="dialog-foot">
          <button ref={cancelRef} className="btn" onClick={() => c.resolve(false)}>
            キャンセル
          </button>
          <button className={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => c.resolve(true)}>
            {c.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function agentTitle(agent: AgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex';
}
