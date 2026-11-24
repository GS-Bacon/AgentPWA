// Claude 用 Driver: ユーザーがログイン済みの claude CLI をヘッドレス（-p + stream-json）で動かす。
// Claude Agent SDK と API キーは使わない（サブスクリプションの枠で動かすため）。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentDriver, AuthCheck, DriverEvent, DriverSession, StartOptions } from '@agentpwa/shared';
import { checkClaudeAuth } from './auth.ts';
import { createLocalLauncher, pathFor, type ProcessLauncher } from './launcher.ts';
import { ClaudeSession } from './session.ts';

export { checkClaudeAuth, mapAuthMethod, detectApiKeyEnv } from './auth.ts';
export { StreamMapper } from './mapper.ts';
export { buildPrompt, summarizeTool, sessionAllowKey, toClaudePermissionMode, fromClaudePermissionMode } from './permissions.ts';
export { createLocalLauncher, pathFor, type ProcessLauncher, type LaunchSpec, type MachineOs, type RunResult } from './launcher.ts';

export interface ClaudeDriverOptions {
  /** claude CLI のパス。省略時は PATH と ~/.local/bin を探す（local のとき） */
  claudePath?: string;
  /** 子プロセスの起動役。省略時はこのPC（local） */
  launcher?: ProcessLauncher;
  env?: NodeJS.ProcessEnv;
  /** 旧版（MCP の許可サーバー）の名残。使わない */
  nodePath?: string;
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

/**
 * claude CLI がセッションの履歴を置くフォルダ名。作業フォルダの英数字以外を `-` に置き換えたもの
 * （例: `C:\Users\me\work` → `C--Users-me-work`）。Claude Code 2.1.327 で確認。
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** resume_token（= session_id）として受け付ける形。パスに使うので、区切り文字などは通さない。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function createClaudeDriver(options: ClaudeDriverOptions = {}): AgentDriver {
  const env = options.env ?? process.env;
  const launcher = options.launcher ?? createLocalLauncher();
  const claudePath = options.claudePath || (options.launcher ? 'claude' : findClaude(env));

  return {
    kind: 'claude',
    checkAuth(): Promise<AuthCheck> {
      return checkClaudeAuth(launcher, claudePath, env);
    },
    async start(opts: StartOptions, emit: (event: DriverEvent) => void): Promise<DriverSession> {
      const session = new ClaudeSession(opts, emit, { launcher, claudePath, env });
      await session.init();
      return session;
    },
    async deleteHistory(target: { cwd: string; resumeToken: string }): Promise<void> {
      if (!SESSION_ID_RE.test(target.resumeToken)) throw new Error('resume_token の形式が正しくありません');
      const p = pathFor(launcher.os);
      // CLAUDE_CONFIG_DIR は local のときだけ見る（ssh 先の環境変数は分からない）
      const configDir = !options.launcher && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : p.join(await launcher.homeDir(), '.claude');
      const dir = p.join(configDir, 'projects', projectDirName(target.cwd));
      // 会話の記録（<id>.jsonl）と、サブエージェントなどの記録を置く同名のフォルダ
      await launcher.remove([p.join(dir, `${target.resumeToken}.jsonl`), p.join(dir, target.resumeToken)]);
    },
  };
}
