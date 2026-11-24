// 設定（Hub の状態、認証、プロジェクト、表示）
import { useState } from 'react';
import { DEFAULT_PERMISSION_MODE, type AgentKind } from '@agentpwa/shared';
import type { ProjectColor } from '@agentpwa/hub/api';
import { moveProject, setProjectColor, useStore } from '../lib/store.ts';
import { resetLayout } from '../lib/layout.ts';
import { AGENT_COLOR, AGENT_LABEL, MODE_LABEL, PROJECT_COLOR_HEX, PROJECT_COLOR_LABEL, PROJECT_COLORS } from '../lib/format.ts';
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
          <Row key={f.path} label={f.name}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: AGENT_COLOR[f.agent], fontSize: 13 }}>
              <AgentIcon agent={f.agent} /> 既定: {AGENT_LABEL[f.agent]}
              {/* 並び順（一覧の順。全端末で共有する） */}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button className="btn btn-icon-sm" aria-label={`${f.name} を上へ`} title="上へ" disabled={i === 0} onClick={() => moveProject(f.path, i - 1)}>
                  ↑
                </button>
                <button className="btn btn-icon-sm" aria-label={`${f.name} を下へ`} title="下へ" disabled={i === all.length - 1} onClick={() => moveProject(f.path, i + 1)}>
                  ↓
                </button>
              </span>
            </span>
            <span className="mono" style={{ fontSize: 12 }}>{f.path}</span>
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>
              既定の権限モード: {MODE_LABEL[f.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE]} ·{' '}
              {f.allowFullAuto ? <span style={{ color: 'var(--attention)' }}>「すべて自動」を許可</span> : '「すべて自動」は不可'}
            </span>
            <ColorPalette name={f.name} value={f.color} onChange={(c) => setProjectColor(f.path, c)} />
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
          。作ったプロジェクトは設定ファイルの folders に書き足されます。並び順は ↑↓（iPad / Web では一覧のプロジェクト名のドラッグでも）で変えられ、全端末で共有されます。色はパレットから選べます（ペインの上部と一覧が、その色で塗られます）。そのほかの変更・削除は、設定ファイルの folders を編集して保存します（Hub が自動で読み直します）。
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
