// モデルとエフォートの選択肢（新規セッションの画面と、ペインの入力欄の上のメニューで共通に使う）。
import type { AgentKind, EffortLevel } from '@agentpwa/shared';

/** value が空文字のものは「エージェントの既定」。正式名（claude-…）は版を固定したいとき用 */
export const MODELS: Record<AgentKind, { value: string; label: string }[]> = {
  claude: [
    { value: '', label: '既定' },
    { value: 'opus', label: 'Opus（最新）' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-opus-5', label: 'Opus 5' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'fable', label: 'Fable' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [{ value: '', label: '既定' }],
};

/** 解決済みの正式名を短い名前にする（一覧にないものは正式名のまま） */
const RESOLVED_LABEL: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-fable-5-2': 'Fable 5.2',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-haiku-5-5': 'Haiku 5.5',
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

/** 実際に使われるモデル（Driver が解決した正式名）の表示名 */
export function resolvedModelLabel(resolved: string): string {
  return RESOLVED_LABEL[resolved] ?? resolved;
}

/** モデルの表示名。一覧にない名前（正式名など）はそのまま出す */
export function modelLabel(agent: AgentKind, model: string | undefined): string {
  return MODELS[agent].find((m) => m.value === (model ?? ''))?.label ?? model ?? '既定';
}

// ---- 既定の覚え書き ----
// 既定のモデルは、既定で動いているセッションからしか分からない。分かったらこの端末に覚えておき、
// 別のモデルを選んでいるときや新規セッションの画面でも「既定（Opus 5.5）」と出せるようにする。

const DEFAULTS_KEY = 'agentpwa.agentDefaults';
type KnownDefault = { model?: string; effort?: EffortLevel };

function loadDefaults(): Partial<Record<AgentKind, KnownDefault>> {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** 既定のモデル（とそのときの既定のエフォート）。まだ分からなければ空 */
export function knownDefault(agent: AgentKind): KnownDefault {
  return loadDefaults()[agent] ?? {};
}

/** セッションの設定から既定を覚える（モデルを指定していないセッションのときだけ） */
export function rememberDefault(agent: AgentKind, s: { model?: string; effort?: EffortLevel; resolvedModel?: string; resolvedEffort?: EffortLevel }): void {
  if (s.model || !s.resolvedModel) return;
  const all = loadDefaults();
  const prev = all[agent] ?? {};
  // エフォートの既定は、エフォートも指定していないときだけ分かる
  const next: KnownDefault = { model: s.resolvedModel, effort: s.effort ? (prev.model === s.resolvedModel ? prev.effort : undefined) : s.resolvedEffort };
  if (next.model === prev.model && next.effort === prev.effort) return;
  all[agent] = next;
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(all));
  } catch {
    /* 保存できなくても表示が減るだけ */
  }
}

// ---- 前回選んだモデルとエフォート ----
// 新規セッションの画面やペインのメニューで選んだものを、プロジェクトごと（とエージェントごと）にこの端末に覚える。
// プロジェクト横の＋で始めるセッションや、新規セッションの画面の初期値に使う。

const CHOICE_KEY = 'agentpwa.lastChoice.v1';
/** 以前の新規セッションの画面の覚え書き（プロジェクトごとの覚え書きがないときの予備） */
const OLD_LAST_KEY = 'agentpwa.newSession.v1';
export type Choice = { model?: string; effort?: EffortLevel };
type Choices = { byCwd?: Record<string, Choice>; byAgent?: Partial<Record<AgentKind, Choice>> };

function loadChoices(): Choices {
  try {
    return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** 選べないもの（エージェントが違う・一覧から消えた）を外す */
function validChoice(agent: AgentKind, c: Choice | undefined): Choice {
  if (!c) return {};
  return {
    model: c.model && MODELS[agent].some((m) => m.value === c.model) ? c.model : undefined,
    effort: c.effort && EFFORTS[agent].includes(c.effort) ? c.effort : undefined,
  };
}

/** そのプロジェクトで前回選んだモデルとエフォート。なければ同じエージェントで前回選んだもの */
export function lastChoice(cwd: string, agent: AgentKind): Choice {
  const all = loadChoices();
  const own = all.byCwd?.[cwd.toLowerCase()];
  if (own) return validChoice(agent, own);
  const byAgent = all.byAgent?.[agent];
  if (byAgent) return validChoice(agent, byAgent);
  try {
    return validChoice(agent, JSON.parse(localStorage.getItem(OLD_LAST_KEY) ?? '{}'));
  } catch {
    return {};
  }
}

/** 選んだモデルとエフォートを覚える（undefined は「既定」） */
export function rememberChoice(cwd: string, agent: AgentKind, c: Choice): void {
  const all = loadChoices();
  const v: Choice = { model: c.model || undefined, effort: c.effort };
  all.byCwd = { ...all.byCwd, [cwd.toLowerCase()]: v };
  all.byAgent = { ...all.byAgent, [agent]: v };
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(all));
  } catch {
    /* 覚えられなくても既定で始まるだけ */
  }
}

/** 「既定」の選択肢の表示名（例: 「既定（Opus 5.5）」） */
export function defaultModelLabel(resolved: string | undefined): string {
  return resolved ? `既定（${resolvedModelLabel(resolved)}）` : '既定';
}

/** エイリアス（opus など）の選択肢に、解決した版を添える（例: 「Opus（最新）— Opus 5.5」） */
export function aliasModelLabel(agent: AgentKind, value: string, resolved: string | undefined): string {
  const base = modelLabel(agent, value);
  if (!resolved || resolved === value) return base;
  return `${base} — ${resolvedModelLabel(resolved)}`;
}

/** エフォートの「既定」の表示名（例: 「既定（中）」） */
export function defaultEffortLabel(resolved: EffortLevel | undefined): string {
  return resolved ? `既定（${EFFORT_LABEL[resolved]}）` : '既定';
}

/** 入力欄の上のボタンに出す文字（例: 「Opus 5.5 · エフォート 中」）。既定でも解決した値が分かればそれを出す */
export function modelSummary(
  agent: AgentKind,
  model: string | undefined,
  effort: EffortLevel | undefined,
  resolved?: { model?: string; effort?: EffortLevel },
): string {
  // エイリアス（opus など）も、解決した版（Opus 5.5 など）で出す
  let m = resolved?.model ? resolvedModelLabel(resolved.model) : model ? modelLabel(agent, model) : '既定のモデル';
  if (!model && resolved?.model) m = `${m}（既定）`;
  const e = effort ?? resolved?.effort;
  if (!e) return m;
  return `${m} · エフォート ${EFFORT_LABEL[e]}${effort ? '' : '（既定）'}`;
}
