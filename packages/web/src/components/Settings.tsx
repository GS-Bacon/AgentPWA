// 設定（Hub の状態、認証、プロジェクト、表示）
import { useState } from 'react';
import { DEFAULT_PERMISSION_MODE, type AgentKind } from '@agentpwa/shared';
import type { FolderEntry, ProjectColor, ProjectTag } from '@agentpwa/hub/api';
import { askConfirm, changeAccess, moveProject, setProjectColor, setProjectTags, useStore } from '../lib/store.ts';
import { resetLayout } from '../lib/layout.ts';
import { AGENT_COLOR, AGENT_LABEL, elapsed, MODE_LABEL, PROJECT_COLOR_HEX, PROJECT_COLOR_LABEL, PROJECT_COLORS } from '../lib/format.ts';
import { UsageBars } from './common.tsx';
import { AgentIcon, IconPlus } from './Icons.tsx';
import { NewProjectForm } from './NewProject.tsx';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="form-legend">{title}</h2>
      <div style={{ borderTop: '1px solid var(--border)' }}>{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'baseline' }}>
      <span className="muted" style={{ width: 110, flex: 'none', fontSize: 13 }}>{label}</span>
      <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

/** プロジェクトの色をパレットから選ぶ（「なし」で外す）。ペインの上部などがこの色で塗られる */
function ColorPalette({ name, value, onChange }: { name: string; value?: ProjectColor; onChange: (c: ProjectColor | null) => void }) {
  return (
    <span role="radiogroup" aria-label={`${name} の色`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 }}>
      <span className="muted" style={{ fontSize: 12, marginRight: 2 }}>色</span>
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        className="color-swatch"
        title="なし"
        aria-label="なし"
        onClick={() => onChange(null)}
        style={{ background: 'transparent', color: 'var(--fg-muted)' }}
      >
        ∅
      </button>
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className="color-swatch"
          title={PROJECT_COLOR_LABEL[c]}
          aria-label={PROJECT_COLOR_LABEL[c]}
          onClick={() => onChange(c)}
          style={{ background: PROJECT_COLOR_HEX[c] }}
        />
      ))}
    </span>
  );
}

/** # の候補を1行1件（「名前 説明」）の文字にする */
function tagsToText(tags: ProjectTag[] | undefined): string {
  return (tags ?? []).map((t) => (t.description ? `${t.name} ${t.description}` : t.name)).join('\n');
}

/** 1行1件（「名前 説明」。名前の先頭の # は省いてよい）の文字を # の候補にする。空の行は飛ばす */
function textToTags(text: string): ProjectTag[] {
  const out: ProjectTag[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[#＃]?(\S+)(?:\s+(.*\S))?\s*$/.exec(line);
    if (!m) continue;
    out.push(m[2] ? { name: m[1], description: m[2] } : { name: m[1] });
  }
  return out;
}

/**
 * 入力欄の # の候補（設定ファイルの folders の tags）。1行1件で編集する。
 * そのプロジェクトの AI も Hub の API で書き換えられる（driver-claude の hub-guide.ts）
 */
function TagsEditor({ folder }: { folder: FolderEntry }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tags = folder.tags ?? [];
  if (draft === null) {
    return (
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, marginTop: 8, fontSize: 12 }}>
        <span className="muted"># の候補</span>
        {tags.length === 0 ? (
          <span className="muted">なし</span>
        ) : (
          <span className="mono ellipsis" style={{ minWidth: 0, flex: '0 1 auto' }} title={tags.map((t) => `#${t.name}`).join(' ')}>
            {tags.slice(0, 8).map((t) => `#${t.name}`).join(' ')}
            {tags.length > 8 ? ` ほか ${tags.length - 8} 件` : ''}
          </span>
        )}
        <button className="btn btn-sm" onClick={() => setDraft(tagsToText(tags))}>
          編集
        </button>
      </span>
    );
  }
  const save = async () => {
    setBusy(true);
    const ok = await setProjectTags(folder, textToTags(draft));
    setBusy(false);
    if (ok) setDraft(null);
  };
  return (
    <span style={{ display: 'block', marginTop: 8 }}>
      <label className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }} htmlFor={`tags-${folder.agent}-${folder.path}`}>
        # の候補（1行に1件。「名前 説明」の形で、説明は省けます）
      </label>
      <textarea
        id={`tags-${folder.agent}-${folder.path}`}
        className="textarea mono"
        rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
        style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
        placeholder={'J01 案件の説明\nJ02'}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      <span style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
          保存
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setDraft(null)}>
          キャンセル
        </button>
      </span>
    </span>
  );
}

/**
 * アクセスの許可（設定ファイルの allowedUsers）。
 * 許可されていない Tailscale ユーザーが開こうとすると「許可待ち」に出るので、ここで許可する。
 */
function AccessSection() {
  const info = useStore((s) => s.info);
  const access = info?.access;
  if (!access) return null;
  const isSelf = (u: string) => !!info?.user && info.user.toLowerCase() === u.toLowerCase();
  const revoke = async (login: string) => {
    const ok = await askConfirm({
      title: 'アクセスの許可を取り消しますか？',
      body: [`${login} は、この Hub を開けなくなります。`],
      confirmLabel: '取り消す',
      danger: true,
    });
    if (ok) await changeAccess('revoke', login);
  };
  return (
    <Section title="アクセス">
      {access.pending.map((p) => (
        <Row key={p.login} label="許可待ち">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 13 }}>{p.login}</span>
              <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                {p.name ? `${p.name} · ` : ''}
                {elapsed(p.lastSeen)}前に開こうとしました
              </span>
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn btn-sm btn-primary" onClick={() => void changeAccess('allow', p.login)}>
                許可
              </button>
              <button className="btn btn-sm" onClick={() => void changeAccess('dismiss', p.login)}>
                無視
              </button>
            </span>
          </span>
        </Row>
      ))}
      {access.allowedUsers.map((u) => (
        <Row key={u} label="許可済み">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 13, minWidth: 0 }}>
              {u}
              {isSelf(u) && <span className="muted">（この端末）</span>}
            </span>
            {!isSelf(u) && (
              <button className="btn btn-sm btn-danger" style={{ marginLeft: 'auto' }} onClick={() => void revoke(u)}>
                取り消す
              </button>
            )}
          </span>
        </Row>
      ))}
      <p className="muted" style={{ padding: '10px 16px', fontSize: 12 }}>
        {access.allowedUsers.length === 0 ? 'まだ誰も許可されていません。' : ''}
        tailscale serve 経由で開けるのは、ここで許可した Tailscale ユーザーだけです。許可されていないユーザーが開こうとすると「許可待ち」に出ます（Hub を再起動すると消えます）。許可したユーザーは、この Hub を通じてこのPCで AI を動かせます。このPCのブラウザ（127.0.0.1）からは、許可なしで開けます。
      </p>
    </Section>
  );
}

/** fullscreen: iPhone では「新しいプロジェクト」を全画面で開く */
export function Settings({ fullscreen }: { fullscreen?: boolean } = {}) {
  const info = useStore((s) => s.info);
  const connected = useStore((s) => s.connected);
  const usage = useStore((s) => s.usage);
  const [adding, setAdding] = useState(false);
  return (
    <div style={{ paddingBottom: 24 }}>
      <Section title="Hub">
        <Row label="接続">{connected ? <span className="st-running">● 接続中</span> : <span className="st-error">● 切断</span>}</Row>
        <Row label="マシン">{info?.machine ?? '—'}</Row>
        <Row label="ユーザー">{info?.user ?? 'このPCから直接'}</Row>
        <Row label="設定ファイル">
          <span className="mono" style={{ fontSize: 12 }}>{info?.configPath ?? '—'}</span>
        </Row>
      </Section>
      <AccessSection />
      <Section title="エージェント">
        {(['claude', 'codex'] as AgentKind[]).map((a) => {
          const ag = info?.agents[a];
          return (
            <Row key={a} label={AGENT_LABEL[a]}>
              <span className={ag?.auth.ok ? 'st-running' : 'st-error'}>● {ag?.auth.ok ? '利用できます' : '利用できません'}</span>
              <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                {ag?.fake ? '表示確認用のフェイク Driver · ' : ''}
                {ag?.auth.version ? `v${ag.auth.version} · ` : ''}
                {ag?.auth.detail}
              </span>
              {usage[a].length > 0 && (
                <div style={{ marginTop: 8, maxWidth: 320 }}>
                  <UsageBars usage={usage[a]} />
                </div>
              )}
            </Row>
          );
        })}
      </Section>
      <Section title="プロジェクト">
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <button className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setAdding(true)}>
            <IconPlus size={14} /> 新しいプロジェクト
          </button>
        </div>
        {(info?.folders ?? []).map((f, i, all) => (
          <Row key={`${f.agent}:${f.path}`} label={f.name}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: AGENT_COLOR[f.agent], fontSize: 13 }}>
              <AgentIcon agent={f.agent} /> {AGENT_LABEL[f.agent]}
              {/* 並び順（一覧の順。全端末で共有する） */}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button className="btn btn-icon-sm" aria-label={`${f.name} を上へ`} title="上へ" disabled={i === 0} onClick={() => moveProject(f, i - 1)}>
                  ↑
                </button>
                <button className="btn btn-icon-sm" aria-label={`${f.name} を下へ`} title="下へ" disabled={i === all.length - 1} onClick={() => moveProject(f, i + 1)}>
                  ↓
                </button>
              </span>
            </span>
            <span className="mono" style={{ fontSize: 12 }}>{f.path}</span>
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>
              既定の権限モード: {MODE_LABEL[f.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE]} ·{' '}
              {f.allowFullAuto ? <span style={{ color: 'var(--attention)' }}>「すべて自動」を許可</span> : '「すべて自動」は不可'}
            </span>
            <ColorPalette name={f.name} value={f.color} onChange={(c) => setProjectColor(f, c)} />
            <TagsEditor folder={f} />
          </Row>
        ))}
        <p className="muted" style={{ padding: '10px 16px', fontSize: 12 }}>
          画面から作れるのは、設定ファイルの projectRoots（ルートフォルダ）の下のフォルダだけです
          {info?.projectRoots.length ? (
            <>
              （<span className="mono">{info.projectRoots.join(' / ')}</span>）
            </>
          ) : (
            '（未設定のため、いまは画面から作れません）'
          )}
          。作ったプロジェクトは設定ファイルの folders に書き足されます。並び順は ↑↓（iPad / Web では一覧のプロジェクト名のドラッグでも）で変えられ、全端末で共有されます。色はパレットから選べます（ペインの上部と一覧が、その色で塗られます）。# の候補は、入力欄で # を打ったときに出ます（そのプロジェクトの AI に頼んで書き換えてもらうこともできます）。そのほかの変更・削除は、設定ファイルの folders を編集して保存します（Hub が自動で読み直します）。
        </p>
      </Section>
      <Section title="表示">
        <div style={{ padding: '10px 16px' }}>
          <button
            className="btn"
            onClick={() => {
              if (window.confirm('この端末のペインの並びを初期状態に戻しますか？')) {
                resetLayout();
                location.reload();
              }
            }}
          >
            ペインの並びを初期化
          </button>
        </div>
      </Section>
      {adding && <NewProjectForm fullscreen={fullscreen} onClose={() => setAdding(false)} onCreated={() => setAdding(false)} />}
    </div>
  );
}
