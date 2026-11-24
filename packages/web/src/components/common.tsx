// 小さな共通部品
import { useEffect, useRef, useState } from 'react';
import type { AgentKind } from '@agentpwa/shared';
import type { SessionSummary, UsageInfo } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { run, useStore } from '../lib/store.ts';
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

export function SessionMenu({ s, extra }: { s: SessionSummary; extra?: { label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = (label: string, fn: () => void, danger = false) => (
    <button
      className={danger ? 'danger' : undefined}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn btn-ghost btn-icon" aria-label="メニュー" aria-expanded={open} onClick={() => setOpen(!open)} style={{ width: 36, height: 36 }}>
        <IconMore />
      </button>
      {open && (
        <div className="menu" role="menu">
          {extra?.map((e) => item(e.label, e.onClick))}
          {item('名前を変更', () => {
            const t = window.prompt('セッションの名前', s.title);
            if (t && t.trim()) void run(() => api.update(s.id, { title: t }));
          })}
          {s.live
            ? item('停止', () => void run(() => api.stop(s.id)), true)
            : item(s.resumable ? '再開' : '起動', () => void run(() => api.resume(s.id)))}
          {item(s.archived ? 'アーカイブから戻す' : 'アーカイブ', () => void run(() => api.update(s.id, { archived: !s.archived })))}
        </div>
      )}
    </div>
  );
}

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

export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed', left: '50%', bottom: 'calc(96px + var(--safe-bottom))', transform: 'translateX(-50%)', zIndex: 60,
        background: 'var(--bg-muted)', border: '1px solid var(--danger)', color: 'var(--fg)', padding: '8px 14px', maxWidth: 'calc(100% - 32px)', fontSize: 13,
      }}
    >
      {toast}
    </div>
  );
}

export function agentTitle(agent: AgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex';
}
