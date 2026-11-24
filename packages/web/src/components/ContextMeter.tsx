// コンテキスト（会話の文脈）の使用量。ペインの入力欄の上、モデルとエフォートのボタンの横に出す。
// Driver が context イベントで送った値（直近の API 呼び出しのトークン数と、モデルの上限）を割合で示す。
import type { SessionSummary } from '@agentpwa/hub/api';
import { usageColor } from './common.tsx';

/** 27074 → 27k、1000000 → 1M */
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function ContextMeter({ session: s }: { session: SessionSummary }) {
  const c = s.context;
  if (!c || c.usedTokens <= 0) return null;
  const used = c.usedTokens.toLocaleString();
  if (!c.windowTokens) {
    return (
      <span className="ctx-meter" title={`コンテキスト: ${used} トークン（上限はターンが終わると分かります）`}>
        <span>コンテキスト {shortTokens(c.usedTokens)}</span>
      </span>
    );
  }
  const percent = Math.min(100, (c.usedTokens / c.windowTokens) * 100);
  const shown = percent > 0 && percent < 1 ? '<1' : String(Math.round(percent));
  const color = usageColor(percent);
  return (
    <span
      className="ctx-meter"
      role="meter"
      aria-label="コンテキストの使用量"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      title={`コンテキスト: ${used} / ${c.windowTokens.toLocaleString()} トークン（${shortTokens(c.windowTokens)}）`}
    >
      <span className="ctx-bar" aria-hidden="true">
        <span style={{ width: `${percent}%`, background: color }} />
      </span>
      <span>コンテキスト <span style={{ color }}>{shown}%</span></span>
    </span>
  );
}
