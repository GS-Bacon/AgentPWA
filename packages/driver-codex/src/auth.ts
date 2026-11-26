import type { AuthCheck } from '@agentpwa/shared';
import type { RpcClient, Wire } from './rpc.ts';

export function environmentAuth(env: NodeJS.ProcessEnv): AuthCheck | undefined {
  const key = Object.keys(env).find((key) => env[key]?.trim() && (
    /^(OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY|OPENAI_AUTH_TOKEN|OPENAI_BASE_URL|OPENAI_API_BASE|AZURE_OPENAI_ENDPOINT|CODEX_OSS_BASE_URL|CODEX_OSS_PORT)$/i.test(key)
  ));
  if (key) return { ok: false, auth: 'api_key', detail: `${key} が設定されています。従量課金を避けるため起動しません` };
}

export async function inspectAuth(rpc: RpcClient, cwd?: string): Promise<AuthCheck> {
  const { config } = await rpc.request('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) });
  if (!config || typeof config !== 'object') return { ok: false, auth: 'unknown', detail: '有効な設定を確認できません' };
  // 任意の接続先や OpenAI プロバイダーの上書きは、ChatGPT ログインがあっても許可しない。
  if ((config.model_provider && config.model_provider !== 'openai') || config.model_providers?.openai ||
      config.forced_login_method === 'api' || config.openai_base_url) {
    return { ok: false, auth: 'api_key', detail: 'API または独自プロバイダーの設定があります。ChatGPT 標準接続だけを利用できます' };
  }
  const { account } = await rpc.request('account/read', { refreshToken: false });
  if (!account) return { ok: false, auth: 'none', detail: 'codex login で ChatGPT にログインしてください' };
  if (account.type === 'chatgpt') return { ok: true, auth: 'subscription' };
  if (['apiKey', 'amazonBedrock', 'gcp'].includes(account.type)) {
    return { ok: false, auth: 'api_key', detail: '従量課金の認証が選ばれています。起動しません' };
  }
  return { ok: false, auth: 'unknown', detail: 'ChatGPT ログインであることを確認できません' };
}

export function rateSnapshots(result: Wire): Wire[] {
  const buckets = result.rateLimitsByLimitId;
  if (buckets && Object.keys(buckets).length) return Object.values(buckets).filter(Boolean) as Wire[];
  return result.rateLimits ? [result.rateLimits] : [];
}

export function assertPlanQuota(result: Wire) {
  const snapshots = rateSnapshots(result);
  const windows = snapshots.flatMap((s) => [s.primary, s.secondary]).filter(Boolean);
  // クレジットへの自動移行を避ける。枠が確認できない場合も推論を開始しない。
  if (result.ordinaryUsageAllowed !== true || !windows.length || windows.some((w) => !Number.isFinite(w.usedPercent) || w.usedPercent >= 100) ||
      snapshots.some((s) => s.credits?.hasCredits !== false || s.credits?.unlimited === true) ||
      snapshots.some((s) => s.spendControlReached === true || s.rateLimitReachedType)) {
    throw new Error('ChatGPT プランの利用枠が不足、または確認できません。追加クレジットを使わず停止します');
  }
}
