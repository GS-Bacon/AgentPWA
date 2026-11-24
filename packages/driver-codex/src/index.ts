import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AgentDriver, AuthCheck } from '@agentpwa/shared';
import { environmentAuth, inspectAuth } from './auth.ts';
import { localLaunch, RpcClient, type Launch } from './rpc.ts';
import { CodexSession } from './session.ts';

/** ChatGPT プランのログインだけで動かす Driver。 */
export function createCodexDriver(options: { codexPath?: string } = {}): AgentDriver {
  const command = options.codexPath ?? 'codex';
  return createDriver({
    launch: (cwd) => localLaunch(command, { ...process.env })(cwd),
    version: () => new Promise<string | undefined>((resolve) => {
      execFile(command, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : stdout.trim().match(/^codex-cli\s+[\w.+-]+/m)?.[0]);
      });
    }),
  });
}

// テストでは子プロセスだけを差し替え、同じ認証検査とセッション実装を通す。
export function createDriver(runtime: { launch: Launch; version: () => Promise<string | undefined> }): AgentDriver {
  return {
    kind: 'codex',
    supportsAttachments: false,
    async checkAuth(): Promise<AuthCheck> {
      const blocked = environmentAuth(process.env);
      if (blocked) return blocked;
      let rpc: RpcClient | undefined;
      try {
        const version = await runtime.version();
        if (!version) return { ok: false, auth: 'none', detail: 'Codex CLI を確認できません。codexPath に実行ファイルを指定してください' };
        rpc = new RpcClient(runtime.launch());
        rpc.onMessage = (msg) => { if (msg.id !== undefined) rpc?.unsupported(msg.id); };
        await rpc.initialize();
        return { ...await inspectAuth(rpc), version };
      } catch {
        return { ok: false, auth: 'unknown', detail: 'Codex の認証方式を確認できないため起動しません' };
      } finally { await rpc?.close(); }
    },
    async start(opts, emit) {
      const blocked = environmentAuth(process.env);
      if (blocked) throw new Error(blocked.detail);
      const resolved = { ...opts, cwd: path.resolve(opts.cwd) };
      const rpc = new RpcClient(runtime.launch(resolved.cwd));
      const session = new CodexSession(rpc, resolved, emit);
      await session.start();
      return session;
    },
  };
}
