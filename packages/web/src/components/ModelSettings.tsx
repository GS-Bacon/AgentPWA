// モデルとエフォートの切り替え（ペインの入力欄の上のボタンとメニュー）。
// 実行中・許可待ちのどの状態でも切り替えられる。Driver が model イベントで反映を知らせると表示が確定する。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EffortLevel } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { run, useStore } from '../lib/store.ts';
import { EFFORTS, EFFORT_LABEL, MODELS, aliasModelLabel, defaultEffortLabel, defaultModelOptionLabel, knownDefault, modelSummary, rememberDefault } from '../lib/models.ts';
import { useDismiss } from './common.tsx';

/** 反映を待つ時間。これを過ぎても model が来なければ（失敗）、表示を元に戻す */
const PENDING_MS = 8000;

interface Shown {
  model: string | undefined;
  effort: EffortLevel | undefined;
}

export function ModelButton({ session: s, disabled }: { session: SessionSummary; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, setPendingState] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  const setPending = useCallback((p: Shown | null) => {
    setPendingState(p);
    if (timer.current) clearTimeout(timer.current);
    timer.current = p ? setTimeout(() => setPending(null), PENDING_MS) : null;
  }, []);
  // Driver が現在の設定を知らせてきたら、待ちを解く
  useEffect(() => setPending(null), [s.model, s.effort, setPending]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // 既定で動いているセッションから、既定のモデルが何かを覚えておく
  useEffect(() => rememberDefault(s.agent, s), [s.agent, s.model, s.effort, s.resolvedModel, s.resolvedEffort]);

  const shown: Shown = pending ?? { model: s.model, effort: s.effort };
  // 解決済みの値は、切り替え中は古いので使わない
  const resolved = pending ? undefined : { model: s.resolvedModel, effort: s.resolvedEffort };
  const defModel = !shown.model && resolved?.model ? resolved.model : knownDefault(s.agent).model;
  // 設定の既定（agentDefaults）。「既定」を選ぶと、Hub がこれに切り替える（無ければ CLI の既定）
  const configured = useStore((st) => st.info?.agentDefaults?.[s.agent]) ?? {};
  const models = MODELS[s.agent];
  // 一覧にないモデル（正式名で始めたセッションなど）も選択中として出す
  const modelItems = shown.model && !models.some((m) => m.value === shown.model) ? [...models, { value: shown.model, label: shown.model }] : models;

  const apply = async (patch: { model?: string | null; effort?: EffortLevel | null }) => {
    setOpen(false);
    // 「既定」（null）は、Hub が設定の既定に置き換える
    const next: Shown = {
      model: patch.model === undefined ? shown.model : patch.model ?? configured.model,
      effort: patch.effort === undefined ? shown.effort : patch.effort ?? configured.effort,
    };
    if (next.model === shown.model && next.effort === shown.effort) return;
    setPending(next);
    const ok = await run(() => api.action(s.id, { type: 'set_model', ...patch }));
    if (!ok) setPending(null);
  };

  const label = modelSummary(s.agent, shown.model, shown.effort, resolved);
  return (
    <div className="menu-wrap" ref={ref} style={{ flex: 'none', minWidth: 0 }}>
      <button
        className="btn meta-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`モデルとエフォート: ${label}${pending ? '（切り替え中）' : ''}`}
        title={pending ? '切り替え中…' : 'モデルとエフォート'}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        style={{ opacity: pending ? 0.6 : undefined }}
      >
        <span className="ellipsis">{label}</span>
        <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--fg-muted)' }}>▼</span>
      </button>
      {open && (
        <div className="menu menu-up" role="menu" aria-label="モデルとエフォート" style={{ minWidth: 200 }}>
          <div className="menu-head">モデル</div>
          {modelItems.map((m) => {
            const on = (shown.model ?? '') === m.value;
            return (
              <button key={`m-${m.value}`} role="menuitemradio" aria-checked={on} className="menu-mode" onClick={() => void apply({ model: m.value || null })}>
                <span className="menu-check" aria-hidden="true">{on ? '✓' : ''}</span>
                <span>{m.value === '' ? defaultModelOptionLabel(s.agent, configured.model, defModel) : on ? aliasModelLabel(s.agent, m.value, resolved?.model) : m.label}</span>
              </button>
            );
          })}
          <div className="menu-head menu-sep">エフォート</div>
          {[undefined, ...EFFORTS[s.agent]].map((e) => {
            const on = shown.effort === e;
            return (
              <button key={`e-${e ?? ''}`} role="menuitemradio" aria-checked={on} className="menu-mode" onClick={() => void apply({ effort: e ?? null })}>
                <span className="menu-check" aria-hidden="true">{on ? '✓' : ''}</span>
                <span>{e ? EFFORT_LABEL[e] : defaultEffortLabel(configured.effort ?? (shown.effort ? undefined : resolved?.effort))}</span>
              </button>
            );
          })}
          <div className="menu-foot">実行中でも切り替えられます</div>
        </div>
      )}
    </div>
  );
}
