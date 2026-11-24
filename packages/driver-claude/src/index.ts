// Claude 用 Driver: ユーザーがログイン済みの claude CLI をヘッドレス（-p + stream-json）で動かす。
// Claude Agent SDK と API キーは使わない（サブスクリプションの枠で動かすため）。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentDriver, AuthCheck, DriverEvent, DriverSession, StartOptions } from '@agentpwa/shared';
import { checkClaudeAuth } from './auth.ts';
import { PermissionBridge } from './bridge.ts';
import { ClaudeSession } from './session.ts';

export { checkClaudeAuth, mapAuthMethod, detectApiKeyEnv } from './auth.ts';
export { StreamMapper } from './mapper.ts';
export { buildPrompt, summarizeTool, sessionAllowKey, toClaudePermissionMode } from './permissions.ts';

export interface ClaudeDriverOptions {
  /** claude CLI のパス。省略時は PATH と ~/.local/bin を探す */
  claudePath?: string;
  /** 許可用 MCP サーバーを動かす node のパス。省略時は今の node */
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
}

/** claude CLI の場所を探す（PATH → ~/.local/bin）。 */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return exe;
}

export function createClaudeDriver(options: ClaudeDriverOptions = {}): AgentDriver {
  const env = options.env ?? process.env;
  const claudePath = options.claudePath || findClaude(env);
  const nodePath = options.nodePath ?? process.execPath;
  const bridge = new PermissionBridge();

  return {
    kind: 'claude',
    checkAuth(): Promise<AuthCheck> {
      return checkClaudeAuth(claudePath, env);
    },
    async start(opts: StartOptions, emit: (event: DriverEvent) => void): Promise<DriverSession> {
      const session = new ClaudeSession(opts, emit, { claudePath, nodePath, env, bridge });
      await session.init();
      return session;
    },
  };
}
