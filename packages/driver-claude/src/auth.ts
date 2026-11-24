// 認証状態の確認。サブスクリプション（Claude Pro/Max/Team）で動くときだけ起動を許す。
import type { AuthCheck } from '@agentpwa/shared';
import type { ProcessLauncher } from './launcher.ts';

/** これらが設定されていると、claude CLI は API キー（従量課金）やクラウド事業者経由で動く。 */
export const API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/** `claude auth status`（既定で JSON）の authMethod を、プロトコルの auth に対応付ける。 */
export function mapAuthMethod(authMethod: string | undefined, loggedIn: boolean | undefined): AuthCheck['auth'] {
  switch (authMethod) {
    case 'claude.ai':
    case 'oauth_token':
      return 'subscription';
    case 'api_key':
    case 'api_key_helper':
    case 'third_party':
      return 'api_key';
    case 'none':
      return 'none';
    default:
      return loggedIn === false ? 'none' : 'unknown';
  }
}

export function detectApiKeyEnv(env: NodeJS.ProcessEnv): string | undefined {
  return API_KEY_ENV_VARS.find((k) => {
    const v = env[k];
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
}

export async function checkClaudeAuth(launcher: ProcessLauncher, claudePath: string, env: NodeJS.ProcessEnv): Promise<AuthCheck> {
  const keyVar = detectApiKeyEnv(env);
  const ver = await launcher.run({ command: claudePath, args: ['--version'], env });
  if (ver.code === -1) {
    return { ok: false, auth: 'unknown', detail: `claude CLI が見つかりません（${claudePath}）` };
  }
  const version = ver.stdout.trim().split(/\s+/)[0] || undefined;
  if (keyVar) {
    return { ok: false, version, auth: 'api_key', detail: `${keyVar} が設定されています。従量課金を避けるため起動しません` };
  }
  const st = await launcher.run({ command: claudePath, args: ['auth', 'status'], env });
  let parsed: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
  try {
    parsed = JSON.parse(st.stdout);
  } catch {
    return { ok: false, version, auth: 'unknown', detail: '`claude auth status` の結果を読み取れませんでした' };
  }
  const auth = mapAuthMethod(parsed.authMethod, parsed.loggedIn);
  if (auth === 'subscription') {
    const plan = parsed.subscriptionType ? `（${parsed.subscriptionType}）` : '';
    return { ok: true, version, auth, detail: `claude.ai でログイン済み${plan}` };
  }
  if (auth === 'api_key') {
    return { ok: false, version, auth, detail: `API キー方式でログインしています（${parsed.authMethod}）。サブスクリプションでログインし直してください` };
  }
  if (auth === 'none') {
    return { ok: false, version, auth, detail: 'ログインしていません。このPCで `claude` を起動して /login してください' };
  }
  return { ok: false, version, auth, detail: `認証方式を判別できませんでした（${parsed.authMethod ?? '不明'}）` };
}
