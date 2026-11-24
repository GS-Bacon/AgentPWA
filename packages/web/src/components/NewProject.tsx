// 新しいプロジェクトの作成フォーム（iPhone は全画面、iPad / Web はダイアログ）。
// 設定タブと新規セッションの開始画面から開く（docs/architecture.md の 6.3）。
// いまはこのPCだけ。作り方は「既存のフォルダを選ぶ」「新しいフォルダを作る」の2つ（git clone と SSH 先は後のフェーズ）。
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type AgentKind, type PermissionMode } from '@agentpwa/shared';
import type { DirListing, FolderEntry } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { showToast, useStore } from '../lib/store.ts';
import { AGENT_COLOR, AGENT_LABEL, MODE_LABEL } from '../lib/format.ts';
import { confirmFullAuto } from '../lib/sessionActions.ts';
import { AgentIcon, IconClose } from './Icons.tsx';

type Mode = 'existing' | 'new';

function Legend({ children }: { children: React.ReactNode }) {
  return <legend className="form-legend">{children}</legend>;
}

const fieldset: React.CSSProperties = { margin: 0, padding: 0, border: 'none' };
const listBox: React.CSSProperties = { borderTop: '1px solid var(--border)' };

export function NewProjectForm({
  onClose,
  onCreated,
  fullscreen,
}: {
  onClose: () => void;
  onCreated: (f: FolderEntry) => void;
  fullscreen?: boolean;
}) {
  const info = useStore((s) => s.info);
  const roots = info?.projectRoots ?? [];
  const [mode, setMode] = useState<Mode>('existing');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [name, setName] = useState('');
  const usable = (a: AgentKind) => info?.agents[a]?.auth.ok === true;
  const [agent, setAgent] = useState<AgentKind>(() => (usable('claude') || !usable('codex') ? 'claude' : 'codex'));
  const [allowFullAuto, setAllowFullAuto] = useState(false);
  const [defaultMode, setDefaultMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [busy, setBusy] = useState(false);

  // 遅れて届いた古い一覧で上書きしないよう、最後に頼んだものだけ使う
  const reqId = useRef(0);
  const open = async (path?: string) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const l = await api.dirs(path);
      if (id === reqId.current) setListing(l);
    } catch (e) {
      if (id === reqId.current) showToast((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (roots.length > 0) void open();
    // ルートの設定が変わったら最初から見直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots.join('\n')]);

  // いま見ているフォルダ（ルートの一覧を見ているときは未選択）
  const current = listing?.path;
  const currentRegistered = current ? (info?.folders ?? []).some((f) => f.path.toLowerCase() === current.toLowerCase()) : false;
  const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
  const target = mode === 'existing' ? current : current && folderName.trim() ? `${current.replace(/[\\/]+$/, '')}${current.includes('\\') ? '\\' : '/'}${folderName.trim()}` : undefined;
  const ready = !!current && !busy && usable(agent) && (mode === 'existing' ? !currentRegistered : !!folderName.trim());

  const toggleFullAuto = async (on: boolean) => {
    if (on && !(await confirmFullAuto())) return;
    setAllowFullAuto(on);
    if (!on && defaultMode === 'full_auto') setDefaultMode(DEFAULT_PERMISSION_MODE);
  };

  const submit = async () => {
    if (!ready || !current) return;
    setBusy(true);
    try {
      const f = await api.createProject({
        mode,
        path: current,
        folderName: mode === 'new' ? folderName.trim() : undefined,
        gitInit: mode === 'new' ? gitInit : undefined,
        name: name.trim() || undefined,
        agent,
        allowFullAuto,
        defaultPermissionMode: defaultMode,
      });
      showToast(`プロジェクト「${f.name}」を作りました`);
      onCreated(f);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browser = (
    <div style={listBox}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)', minHeight: 44 }}>
        <button
          className="btn"
          disabled={!listing?.path || loading}
          onClick={() => void open(listing?.parent)}
          aria-label={listing?.parent ? '一つ上のフォルダへ' : 'ルートフォルダの一覧へ'}
        >
          ↑ 上へ
        </button>
        <span className="mono ellipsis" style={{ fontSize: 12, flex: '1 1 auto', minWidth: 0 }} title={current}>
          {current ?? 'ルートフォルダ'}
        </span>
        {loading && <span className="muted" style={{ fontSize: 12, flex: 'none' }}>読み込み中…</span>}
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {listing && listing.entries.length === 0 && (
          <p className="muted" style={{ padding: '10px 16px', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            {listing.path ? 'サブフォルダはありません' : 'ルートフォルダが見つかりません（設定ファイルの projectRoots のパスを確かめてください）'}
          </p>
        )}
        {listing?.entries.map((e) => (
          <button
            key={e.path}
            className="choice"
            style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
            onClick={() => void open(e.path)}
          >
            <span className={listing.path ? undefined : 'mono'} style={{ flex: '1 1 auto', minWidth: 0, fontSize: listing.path ? undefined : 12 }}>
              {e.name}
            </span>
            {e.registered && <span className="muted" style={{ fontSize: 12, flex: 'none' }}>登録済み</span>}
            <span className="muted" style={{ flex: 'none' }} aria-hidden>
              ›
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  const body = (
    <>
      {roots.length === 0 && (
        <div className="banner banner-info" style={{ display: 'block' }}>
          画面からプロジェクトを作るには、Hub の設定ファイル（<span className="mono">{info?.configPath}</span>）の <span className="mono">projectRoots</span>{' '}
          に、プロジェクトを置いてよいルートフォルダを書いてください（例: <span className="mono">["C:\\Users\\you\\work"]</span>）。保存すると Hub が読み直します。
        </div>
      )}
      <fieldset className="form-section" style={fieldset}>
        <Legend>マシン</Legend>
        <div style={listBox}>
          <label className="choice checked">
            <input type="radio" name="np-host" checked readOnly />
            <span style={{ flex: '1 1 auto' }}>
              {info?.machine ?? '—'} <span className="muted" style={{ fontSize: 12 }}>このPC</span>
            </span>
            <span className="st st-running" style={{ fontWeight: 500 }}>● オンライン</span>
          </label>
        </div>
      </fieldset>
      <fieldset className="form-section" style={fieldset}>
        <Legend>作り方</Legend>
        <div style={listBox}>
          {(
            [
              ['existing', '既存のフォルダを選ぶ'],
              ['new', '新しいフォルダを作る'],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <label key={m} className={`choice${mode === m ? ' checked' : ''}`}>
              <input type="radio" name="np-mode" checked={mode === m} onChange={() => setMode(m)} />
              <span style={{ flex: '1 1 auto' }}>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {roots.length > 0 && (
        <fieldset className="form-section" style={fieldset}>
          <Legend>{mode === 'existing' ? 'フォルダ（開いたフォルダを登録します）' : '作る場所（開いたフォルダの中に作ります）'}</Legend>
          {browser}
          {mode === 'new' && (
            <div style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label className="field">
                新しいフォルダの名前
                <input className="input" value={folderName} placeholder="例: my-app" onChange={(e) => setFolderName(e.target.value)} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)} />
                <span>
                  <span className="mono">git init</span> もする
                </span>
              </label>
            </div>
          )}
          <p className="muted" style={{ padding: '8px 16px 0', fontSize: 12, wordBreak: 'break-all' }}>
            {target ? (
              <>
                登録するフォルダ: <span className="mono">{target}</span>
                {mode === 'existing' && currentRegistered && <span style={{ color: 'var(--danger)' }}>（登録済みです）</span>}
              </>
            ) : mode === 'existing' ? (
              'ルートフォルダを開いて、登録するフォルダまで進んでください'
            ) : (
              '作る場所を開いて、名前を入れてください'
            )}
          </p>
        </fieldset>
      )}
      <fieldset className="form-section" style={fieldset}>
        <Legend>使う AI（プロジェクトごとに固定）</Legend>
        <div style={listBox}>
          {(['claude', 'codex'] as AgentKind[]).map((a) => (
            <label key={a} className={`choice${agent === a ? ' checked' : ''}`} style={usable(a) ? undefined : { opacity: 0.5 }}>
              <input type="radio" name="np-agent" checked={agent === a} disabled={!usable(a)} onChange={() => setAgent(a)} />
              <span style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: 6, color: AGENT_COLOR[a] }}>
                <AgentIcon agent={a} /> {AGENT_LABEL[a]}
              </span>
              {!usable(a) && <span className="muted" style={{ fontSize: 12, flex: 'none' }}>このマシンでは使えません</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <div style={{ padding: '16px 16px 0', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <label className="field">
          名前
          <input className="input" value={name} placeholder={target ? baseName(target) : 'フォルダ名'} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          既定の権限モード
          <select className="select" value={defaultMode} onChange={(e) => setDefaultMode(e.target.value as PermissionMode)} style={defaultMode === 'full_auto' ? { color: 'var(--attention)' } : undefined}>
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m} disabled={m === 'full_auto' && !allowFullAuto}>
                {MODE_LABEL[m]}
                {m === 'full_auto' && !allowFullAuto ? '（許可が必要）' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '12px 16px 16px' }}>
        <input type="checkbox" checked={allowFullAuto} onChange={(e) => void toggleFullAuto(e.target.checked)} />
        <span style={allowFullAuto ? { color: 'var(--attention)' } : undefined}>このプロジェクトで「すべて自動」を許可する</span>
      </label>
    </>
  );

  const head = (
    <div className="dialog-head" style={fullscreen ? { paddingTop: 'calc(10px + var(--safe-top))' } : undefined}>
      <h2>新しいプロジェクト</h2>
      <button className="btn btn-ghost btn-icon" aria-label="閉じる" onClick={onClose} style={{ width: 44, height: 44 }}>
        <IconClose size={18} />
      </button>
    </div>
  );
  const foot = (
    <div className="dialog-foot" style={fullscreen ? { paddingBottom: 'calc(12px + var(--safe-bottom))' } : undefined}>
      <button className="btn btn-primary btn-lg" style={{ flex: fullscreen ? 1 : undefined }} disabled={!ready} onClick={submit}>
        {busy ? '作成中…' : 'プロジェクトを作成'}
      </button>
    </div>
  );

  // 新規セッションの画面（全画面 30 / ダイアログ 50）の上に重ねて開くことがあるので、その上にする。トースト（60）と確認（70）よりは下
  if (fullscreen) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', zIndex: 40 }}>
        {head}
        <div className="dialog-body">{body}</div>
        {foot}
      </div>
    );
  }
  return (
    <div className="overlay" style={{ zIndex: 55 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="新しいプロジェクト">
        {head}
        <div className="dialog-body">{body}</div>
        {foot}
      </div>
    </div>
  );
}
