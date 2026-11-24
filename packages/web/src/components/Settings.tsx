// 設定（Hub の状態、認証、フォルダの許可リスト、表示）
import type { AgentKind } from '@agentpwa/shared';
import { useStore } from '../lib/store.ts';
import { resetLayout } from '../lib/layout.ts';
import { AGENT_COLOR, AGENT_LABEL, MODE_LABEL } from '../lib/format.ts';
import { UsageBars } from './common.tsx';
import { AgentIcon } from './Icons.tsx';

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

export function Settings() {
  const info = useStore((s) => s.info);
  const connected = useStore((s) => s.connected);
  const usage = useStore((s) => s.usage);
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
      <Section title="プロジェクト（作業フォルダの許可リスト）">
        {(info?.folders ?? []).map((f) => (
          <Row key={f.path} label={f.name}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: AGENT_COLOR[f.agent], fontSize: 13 }}>
              <AgentIcon agent={f.agent} /> {AGENT_LABEL[f.agent]}
            </span>
            <span className="mono" style={{ fontSize: 12 }}>{f.path}</span>
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>
              既定の権限モード: {MODE_LABEL[f.defaultPermissionMode ?? 'ask']} ·{' '}
              {f.allowFullAuto ? <span style={{ color: 'var(--attention)' }}>「すべて自動」を許可</span> : '「すべて自動」は不可'}
            </span>
          </Row>
        ))}
        <p className="muted" style={{ padding: '10px 16px', fontSize: 12 }}>
          追加・削除と AI の指定（agent: "claude" / "codex"）、「すべて自動」の許可（allowFullAuto: true）、既定の権限モード（defaultPermissionMode）は、設定ファイルの folders を編集して保存します。Hub が自動で読み直します（管理画面は後のフェーズ）。
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
    </div>
  );
}
