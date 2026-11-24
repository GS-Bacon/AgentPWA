// 新しいセッションの作成フォーム（iPhone は全画面、iPad / Web はダイアログ）。
// プロジェクト（作業フォルダと AI の組）を選んで始める。同じフォルダの Claude と Codex のプロジェクトは別の行に出る。
import { useState } from 'react';
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type AgentKind, type EffortLevel, type PermissionMode } from '@agentpwa/shared';
import type { FolderEntry, SessionSummary } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { showToast, useStore } from '../lib/store.ts';
import { AGENT_COLOR, AGENT_LABEL, MODE_LABEL, MODE_NOTE } from '../lib/format.ts';
import { confirmFullAuto } from '../lib/sessionActions.ts';
import { EFFORTS, EFFORT_LABEL, MODELS, defaultEffortLabel, defaultModelLabel, knownDefault, lastChoice, rememberChoice } from '../lib/models.ts';
import { projectKey, type ProjectRef } from '../lib/projects.ts';
import { AgentIcon, IconClose, IconPlus } from './Icons.tsx';
import { NewProjectForm } from './NewProject.tsx';

const LAST_KEY = 'agentpwa.newSession.v1';

/** 前回セッションを始めたプロジェクト（agent が無いのは古い形。Claude とみなす） */
function loadLast(): { cwd?: string; agent?: AgentKind } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * 画面を挟まずに、そのプロジェクトでセッションを始める（プロジェクト横の＋）。
 * モデルとエフォートはそのプロジェクトで前回選んだもの、権限モードはプロジェクトの既定。失敗したらお知らせを出して null
 */
export async function startSessionIn(folder: FolderEntry): Promise<SessionSummary | null> {
  const c = lastChoice(folder.path, folder.agent);
  try {
    const s = await api.create({ cwd: folder.path, agent: folder.agent, model: c.model, effort: c.effort, permissionMode: folder.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE });
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ cwd: folder.path, agent: folder.agent }));
    } catch {
      /* noop */
    }
    return s;
  } catch (e) {
    showToast((e as Error).message);
    return null;
  }
}

export function NewSessionForm({
  project: initial,
  onClose,
  onCreated,
  fullscreen,
}: {
  /** 初めに選んでおくプロジェクト。省くと前回のプロジェクト */
  project?: ProjectRef;
  onClose: () => void;
  onCreated: (s: SessionSummary) => void;
  fullscreen?: boolean;
}) {
  const info = useStore((s) => s.info);
  const last = loadLast();
  // この画面で作ったプロジェクト。Hub から新しい folders が届くまでの間も選べるようにする
  const [created, setCreated] = useState<FolderEntry | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const base = info?.folders ?? [];
  const keyOf = (f: FolderEntry) => projectKey(f.path, f.agent);
  const folders = created && !base.some((f) => keyOf(f) === keyOf(created)) ? [...base, created] : base;
  // 選んでいるプロジェクト（projectKey）
  const [sel, setSel] = useState(() => {
    const want = initial ?? (last.cwd ? { path: last.cwd, agent: last.agent ?? 'claude' } : undefined);
    const k = want ? projectKey(want.path, want.agent) : '';
    const f = folders.find((x) => keyOf(x) === k) ?? folders[0];
    return f ? keyOf(f) : '';
  });
  // AI はプロジェクトごとに固定（Hub の設定ファイルの folders の agent）
  const folder = folders.find((f) => keyOf(f) === sel);
  const cwd = folder?.path ?? '';
  const agent: AgentKind = folder?.agent ?? 'claude';
  const allowFullAuto = folder?.allowFullAuto === true;
  // 権限モードの既定はプロジェクトの設定（defaultPermissionMode）。なければ「毎回確認」
  const defaultMode = (f: FolderEntry | undefined): PermissionMode => f?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
  // モデルとエフォートは、そのプロジェクトで前回選んだもの（空文字が「既定」）
  const [model, setModel] = useState(() => (cwd ? lastChoice(cwd, agent).model ?? '' : ''));
  const [effort, setEffort] = useState<EffortLevel | ''>(() => (cwd ? lastChoice(cwd, agent).effort ?? '' : ''));
  const pickChoice = (p: string, a: AgentKind) => {
    const c = lastChoice(p, a);
    setModel(c.model ?? '');
    setEffort(c.effort ?? '');
  };
  const select = (f: FolderEntry) => {
    setSel(keyOf(f));
    pickChoice(f.path, f.agent);
    setMode(defaultMode(f));
  };
  const [mode, setMode] = useState<PermissionMode>(() => defaultMode(folder));
  const onProjectCreated = (f: FolderEntry) => {
    setCreated(f);
    setAddingProject(false);
    setSel(keyOf(f));
    pickChoice(f.path, f.agent);
    setMode(f.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE);
  };
  const pickMode = async (m: PermissionMode) => {
    // 「すべて自動」は選ぶときに確認を1回挟む
    if (m === 'full_auto' && !(await confirmFullAuto())) return;
    setMode(m);
  };
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  // 既定が何になるか（既定で動いたセッションから覚えたもの。まだ分からなければ「既定」とだけ出す）
  const known = knownDefault(agent);
  const auth = info?.agents[agent]?.auth;
  const blocked = auth && !auth.ok;

  const submit = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const s = await api.create({ cwd, agent, model: model || undefined, effort: effort || undefined, permissionMode: mode, prompt: prompt.trim() || undefined });
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ cwd, agent }));
      } catch {
        /* noop */
      }
      rememberChoice(cwd, agent, { model: model || undefined, effort: effort || undefined });
      onCreated(s);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      {blocked && <div className="banner banner-error">{auth?.detail ?? '認証を確認できません'}</div>}
      <fieldset className="form-section" style={{ margin: 0, padding: 0, border: 'none' }}>
        <legend className="form-legend">プロジェクト（作業フォルダ）</legend>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {folders.length === 0 && (
            <p className="muted" style={{ padding: '12px 16px', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
              プロジェクトがまだありません。下の「新しいプロジェクト」から作ってください。
            </p>
          )}
          {folders.map((f) => (
            <label key={keyOf(f)} className={`choice${sel === keyOf(f) ? ' checked' : ''}`}>
              <input type="radio" name="dir" checked={sel === keyOf(f)} onChange={() => select(f)} />
              <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AgentIcon agent={f.agent} />
                  {f.name}
                </span>
                <span className="mono muted ellipsis" style={{ fontSize: 11 }}>{f.path}</span>
              </span>
              <span style={{ fontSize: 12, color: AGENT_COLOR[f.agent], flex: 'none' }}>{AGENT_LABEL[f.agent]}</span>
            </label>
          ))}
          <button
            className="choice"
            style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--link)', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
            onClick={() => setAddingProject(true)}
          >
            <span style={{ width: 18, display: 'flex', justifyContent: 'center', flex: 'none' }}>
              <IconPlus size={14} />
            </span>
            <span style={{ flex: '1 1 auto' }}>新しいプロジェクト</span>
          </button>
        </div>
      </fieldset>
      <fieldset className="form-section" style={{ margin: 0, padding: 0, border: 'none' }}>
        <legend className="form-legend">マシン</legend>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <label className="choice checked">
            <input type="radio" name="host" checked readOnly />
            <span style={{ flex: '1 1 auto' }}>
              {info?.machine ?? '—'} <span className="muted" style={{ fontSize: 12 }}>このPC</span>
            </span>
            <span className="st st-running" style={{ fontWeight: 500 }}>● オンライン</span>
          </label>
        </div>
      </fieldset>
      <div style={{ padding: '16px 16px 0', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <label className="field">
          モデル
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS[agent].map((m) => (
              <option key={m.value} value={m.value}>
                {m.value === '' ? defaultModelLabel(known.model) : m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          エフォート
          <select className="select" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
            {/* エフォートの既定はモデルごとに違うので、既定のモデルのときだけ値を添える */}
            <option value="">{defaultEffortLabel(model === '' ? known.effort : undefined)}</option>
            {EFFORTS[agent].map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABEL[e]}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          権限モード
          <select className="select" value={mode} onChange={(e) => void pickMode(e.target.value as PermissionMode)} style={mode === 'full_auto' ? { color: 'var(--attention)' } : undefined}>
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m} disabled={m === 'full_auto' && !allowFullAuto}>
                {MODE_LABEL[m]}
                {m === 'full_auto' && !allowFullAuto ? '（このプロジェクトでは不可）' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {MODE_NOTE[mode] && (
        <p style={{ padding: '6px 16px 0', fontSize: 12, color: mode === 'full_auto' ? 'var(--attention)' : 'var(--fg-muted)' }}>
          {mode === 'full_auto' ? '⚠ ' : ''}
          {MODE_LABEL[mode]}: {MODE_NOTE[mode]}
        </p>
      )}
      <label className="field" style={{ padding: '14px 16px 16px' }}>
        最初の指示
        <textarea
          className="textarea"
          rows={4}
          placeholder="例: web/ に PWA の雛形を作って"
          value={prompt}
          style={{ fontSize: 16, fontWeight: 400, color: 'var(--fg)' }}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
      </label>
    </>
  );

  const head = (
    <div className="dialog-head" style={fullscreen ? { paddingTop: 'calc(10px + var(--safe-top))' } : undefined}>
      <h2>新しいセッション</h2>
      <button className="btn btn-ghost btn-icon" aria-label="閉じる" onClick={onClose} style={{ width: 44, height: 44 }}>
        <IconClose size={18} />
      </button>
    </div>
  );
  const foot = (
    <div className="dialog-foot" style={fullscreen ? { paddingBottom: 'calc(12px + var(--safe-bottom))' } : undefined}>
      <button className="btn btn-primary btn-lg" style={{ flex: fullscreen ? 1 : undefined }} disabled={!cwd || busy || blocked} onClick={submit}>
        {busy ? '起動中…' : 'セッションを開始'}
      </button>
    </div>
  );

  // 「新しいプロジェクト」はこの画面の上に重ねて開く（作ったらそのプロジェクトを選んだ状態で戻る）
  const projectForm = addingProject && <NewProjectForm fullscreen={fullscreen} onClose={() => setAddingProject(false)} onCreated={onProjectCreated} />;

  if (fullscreen) {
    return (
      <>
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', zIndex: 30 }}>
          {head}
          <div className="dialog-body">{body}</div>
          {foot}
        </div>
        {projectForm}
      </>
    );
  }
  return (
    <>
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="新しいセッション">
          {head}
          <div className="dialog-body">{body}</div>
          {foot}
        </div>
      </div>
      {projectForm}
    </>
  );
}
