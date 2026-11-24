// Claude 用 Driver: ユーザーがログイン済みの claude CLI をヘッドレス（-p + stream-json）で動かす。
// Claude Agent SDK と API キーは使わない（サブスクリプションの枠で動かすため）。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentDriver, AuthCheck, DriverEvent, DriverSession, SlashCommand, StartOptions } from '@agentpwa/shared';
import { createLocalAttachmentStore, type AttachmentStore } from './attachments.ts';
import { checkClaudeAuth } from './auth.ts';
import { createLocalLauncher, pathFor, type ProcessLauncher } from './launcher.ts';
import { probeControl } from './probe.ts';
import { ClaudeSession } from './session.ts';

export { checkClaudeAuth, mapAuthMethod, detectApiKeyEnv } from './auth.ts';
export { StreamMapper } from './mapper.ts';
export { buildPrompt, summarizeTool, sessionAllowKey, toClaudePermissionMode, fromClaudePermissionMode } from './permissions.ts';
export { buildUserContent, createLocalAttachmentStore, safeFileName, type AttachmentStore } from './attachments.ts';
export { createLocalLauncher, pathFor, type ProcessLauncher, type LaunchSpec, type MachineOs, type RunResult } from './launcher.ts';

export interface ClaudeDriverOptions {
  /** claude CLI のパス。省略時は PATH と ~/.local/bin を探す（local のとき） */
  claudePath?: string;
  /** 子プロセスの起動役。省略時はこのPC（local） */
  launcher?: ProcessLauncher;
  env?: NodeJS.ProcessEnv;
  /** 既定のモデルとエフォートが実際に何になるかを CLI に聞くか（省略時は聞く） */
  resolveDefaults?: boolean;
  /** 画像以外の添付ファイルの置き場所。省略時は local ならこのPCの一時フォルダ、それ以外は画像だけ受け付ける */
  attachments?: AttachmentStore;
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

/** initialize の応答の commands を SlashCommand に直す。内部用（__ で始まる名前）は除く */
export function parseCommands(v: unknown): SlashCommand[] {
  if (!Array.isArray(v)) return [];
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const c of v as Record<string, unknown>[]) {
    const name = typeof c?.name === 'string' ? c.name.replace(/^\//, '') : '';
    if (!name || name.startsWith('__') || seen.has(name)) continue;
    seen.add(name);
    const cmd: SlashCommand = { name };
    if (typeof c.description === 'string' && c.description) cmd.description = c.description;
    if (typeof c.argumentHint === 'string' && c.argumentHint) cmd.argumentHint = c.argumentHint;
    out.push(cmd);
  }
  return out;
}

export function createClaudeDriver(options: ClaudeDriverOptions = {}): AgentDriver {
  const env = options.env ?? process.env;
  const launcher = options.launcher ?? createLocalLauncher();
  const claudePath = options.claudePath || (options.launcher ? 'claude' : findClaude(env));
  // SSH 先などでは、Hub のPCに保存したファイルを CLI から読めないので、画像以外は受け付けない
  const attachments = options.attachments ?? (options.launcher ? undefined : createLocalAttachmentStore());

  return {
    kind: 'claude',
    supportsAttachments: true,
    checkAuth(): Promise<AuthCheck> {
      return checkClaudeAuth(launcher, claudePath, env);
    },
    async start(opts: StartOptions, emit: (event: DriverEvent) => void): Promise<DriverSession> {
      const session = new ClaudeSession(opts, emit, { launcher, claudePath, env, resolveDefaults: options.resolveDefaults ?? true, attachments });
      await session.init();
      return session;
    },
    async listCommands(cwd: string): Promise<SlashCommand[]> {
      // initialize の応答に、その作業フォルダで使えるコマンド（組み込み・スキル・.claude/commands）が入っている
      const res = await probeControl({ launcher, claudePath, env }, cwd, [], { subtype: 'initialize' });
      return parseCommands(res.commands);
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
