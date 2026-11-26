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
import { forkPoint, formatResumeToken, parseResumeToken, parseTranscript, projectDirName, transcriptPath } from './history.ts';
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
  /** 返答待ちのまま使われなかったプロセスを終わらせるまでの時間（ミリ秒、0 で終わらせない）。省略時は 20 分 */
  idleTimeoutMs?: number;
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

export { projectDirName, parseResumeToken, formatResumeToken, forkPoint, rewindPoint, parseTranscript } from './history.ts';

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

  // CLAUDE_CONFIG_DIR は local のときだけ見る（ssh 先の環境変数は分からない）
  const configDir = !options.launcher && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : undefined;
  // 巻き戻しとフォークは、会話の記録（jsonl）を読める起動役のときだけ
  const canRewind = typeof launcher.readText === 'function';

  return {
    kind: 'claude',
    supportsAttachments: true,
    supportsRewind: canRewind,
    checkAuth(): Promise<AuthCheck> {
      return checkClaudeAuth(launcher, claudePath, env);
    },
    async start(opts: StartOptions, emit: (event: DriverEvent) => void): Promise<DriverSession> {
      const session = new ClaudeSession(opts, emit, { launcher, claudePath, env, resolveDefaults: options.resolveDefaults ?? true, attachments, configDir, rewind: canRewind, idleTimeoutMs: options.idleTimeoutMs });
      await session.init();
      return session;
    },
    async listCommands(cwd: string): Promise<SlashCommand[]> {
      // initialize の応答に、その作業フォルダで使えるコマンド（組み込み・スキル・.claude/commands）が入っている
      const res = await probeControl({ launcher, claudePath, env }, cwd, [], { subtype: 'initialize' });
      return parseCommands(res.commands);
    },
    async deleteHistory(target: { cwd: string; resumeToken: string }): Promise<void> {
      const ref = parseResumeToken(target.resumeToken);
      if (!ref) throw new Error('resume_token の形式が正しくありません');
      // まだ起動していないフォーク・巻き戻し（|fork）の session_id は元のセッションのものなので消さない
      if (!ref.sessionId || ref.fork) return;
      const p = pathFor(launcher.os);
      const dir = p.join(configDir || p.join(await launcher.homeDir(), '.claude'), 'projects', projectDirName(target.cwd));
      // 会話の記録（<id>.jsonl）と、サブエージェントなどの記録を置く同名のフォルダ
      await launcher.remove([p.join(dir, `${ref.sessionId}.jsonl`), p.join(dir, ref.sessionId)]);
    },
    forkToken: canRewind
      ? async (target) => {
          const ref = parseResumeToken(target.resumeToken);
          if (!ref?.sessionId) throw new Error('フォークできる会話がありません');
          const text = await launcher.readText!(await transcriptPath(launcher, configDir, target.cwd, ref.sessionId));
          if (text === null) throw new Error('claude CLI の会話の記録が見つかりません');
          // 発言が最後のターンなら、元のセッションと同じ位置（途中から始める予定ならその位置）まで引き継ぐ
          const at = forkPoint(parseTranscript(text), target.messageId) ?? ref.at;
          return formatResumeToken({ sessionId: ref.sessionId, at, fork: true });
        }
      : undefined,
  };
}
