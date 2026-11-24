// 権限モードの切り替え（ペインの入力欄の左のボタンとメニュー、Shift+Tab での巡回）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { PERMISSION_MODES, type PermissionMode } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';
import { useStore } from '../lib/store.ts';
import { MODE_LABEL, MODE_NOTE, nextCycleMode } from '../lib/format.ts';
import { fullAutoAllowed } from '../lib/projects.ts';
import { confirmFullAuto, requestPermissionMode } from '../lib/sessionActions.ts';
import { useDismiss } from './common.tsx';

/** 反映を待つ時間。これを過ぎても permission_mode が来なければ（失敗）、表示を元のモードに戻す */
const PENDING_MS = 8000;

export interface PermissionSwitch {
  /** ボタンに出すモード（切り替え中は頼んだモード） */
  shown: PermissionMode;
  pending: boolean;
  fullAutoAllowed: boolean;
  pick: (mode: PermissionMode) => Promise<void>;
  /** Shift+Tab: 次のモードへ（「すべて自動」は巡回に入れない） */
  cycle: () => void;
}

export function usePermissionSwitch(s: SessionSummary): PermissionSwitch {
  const info = useStore((st) => st.info);
  const allowed = fullAutoAllowed(info, s.cwd);
  const [pending, setPending] = useState<PermissionMode | null>(null);
  const pendingRef = useRef<PermissionMode | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setP = useCallback((m: PermissionMode | null) => {
    pendingRef.current = m;
    setPending(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = m ? setTimeout(() => setP(null), PENDING_MS) : null;
  }, []);

  // Driver が現在のモードを知らせてきたら、待ちを解く
  useEffect(() => setP(null), [s.permissionMode, setP]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const pick = useCallback(
    async (mode: PermissionMode) => {
      const current = pendingRef.current ?? s.permissionMode;
      if (mode === current) return;
      if (mode === 'full_auto') {
        if (!allowed) return;
        if (!(await confirmFullAuto())) return;
      }
      setP(mode);
      const ok = await requestPermissionMode(s.id, mode);
      if (!ok && pendingRef.current === mode) setP(null);
    },
    [s.id, s.permissionMode, allowed, setP],
  );

  const cycle = useCallback(() => {
    void pick(nextCycleMode(pendingRef.current ?? s.permissionMode));
  }, [pick, s.permissionMode]);

  return { shown: pending ?? s.permissionMode, pending: pending !== null, fullAutoAllowed: allowed, pick, cycle };
}

export function PermissionButton({ sw, disabled, showShortcut }: { sw: PermissionSwitch; disabled?: boolean; showShortcut?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  const full = sw.shown === 'full_auto';
  return (
    <div className="menu-wrap" ref={ref} style={{ flex: 'none' }}>
      <button
        className="btn mode-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`権限モード: ${MODE_LABEL[sw.shown]}${sw.pending ? '（切り替え中）' : ''}`}
        title={sw.pending ? '切り替え中…' : showShortcut ? '権限モード（Shift+Tab で切り替え）' : '権限モード'}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        style={{ color: full ? 'var(--attention)' : undefined, opacity: sw.pending ? 0.6 : undefined }}
      >
        {MODE_LABEL[sw.shown]}
        <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--fg-muted)' }}>▼</span>
      </button>
      {open && (
        <div className="menu menu-up" role="menu" aria-label="権限モード" style={{ minWidth: 250 }}>
          {PERMISSION_MODES.map((m) => {
            const blocked = m === 'full_auto' && !sw.fullAutoAllowed;
            const note = blocked ? 'このプロジェクトでは許可されていません' : m === 'auto' ? MODE_NOTE.auto : undefined;
            const on = m === sw.shown;
            return (
              <button
                key={m}
                role="menuitemradio"
                aria-checked={on}
                disabled={blocked}
                className="menu-mode"
                onClick={() => {
                  setOpen(false);
                  void sw.pick(m);
                }}
              >
                <span className="menu-check" aria-hidden="true">{on ? '✓' : ''}</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={m === 'full_auto' && !blocked ? { color: 'var(--attention)' } : undefined}>{MODE_LABEL[m]}</span>
                  {note && <span className="menu-note">{note}</span>}
                </span>
              </button>
            );
          })}
          {showShortcut && <div className="menu-foot">Shift+Tab で順に切り替え（「すべて自動」を除く）</div>}
        </div>
      )}
    </div>
  );
}
