// モデルとエフォートの選択肢（新規セッションの画面と、ペインの入力欄の上のメニューで共通に使う）。
import type { AgentKind, EffortLevel } from '@agentpwa/shared';

/** value が空文字のものは「エージェントの既定」 */
export const MODELS: Record<AgentKind, { value: string; label: string }[]> = {
  claude: [
    { value: '', label: '既定' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'fable', label: 'Fable' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [{ value: '', label: '既定' }],
};

/** エージェントごとに選べるエフォート（低い順）。Codex の対応は Codex 担当の対応表に合わせて直す */
export const EFFORTS: Record<AgentKind, readonly EffortLevel[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};

/** モデルの表示名。一覧にない名前（正式名など）はそのまま出す */
export function modelLabel(agent: AgentKind, model: string | undefined): string {
  return MODELS[agent].find((m) => m.value === (model ?? ''))?.label ?? model ?? '既定';
}

/** 入力欄の上のボタンに出す文字（例: 「Opus · エフォート 高」） */
export function modelSummary(agent: AgentKind, model: string | undefined, effort: EffortLevel | undefined): string {
  const m = model ? modelLabel(agent, model) : '既定のモデル';
  return effort ? `${m} · エフォート ${EFFORT_LABEL[effort]}` : m;
}
