// claude CLI を短く起動して、制御要求（initialize / get_settings など）を1つだけ聞く。
// ユーザーの指示は送らないので、API は呼ばない（サブスクリプションの枠も使わない）。
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { ProcessLauncher } from './launcher.ts';

/** 親の Claude Code から受け継ぐと子の CLI の動作が変わる環境変数 */
export const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/** 応答が無いときに、あきらめて終了させるまでの時間 */
const PROBE_TIMEOUT_MS = 20_000;

export interface ProbeDeps {
  launcher: ProcessLauncher;
  claudePath: string;
  env: NodeJS.ProcessEnv;
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of STRIP_ENV) delete out[k];
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * `claude -p`（stream-json）を起動し、制御要求を1つ送って応答（response.response）を返す。
 * extraArgs には --model などを渡す。
 */
export function probeControl(deps: ProbeDeps, cwd: string, extraArgs: string[], request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', ...extraArgs];
  const proc = deps.launcher.spawn({ command: deps.claudePath, args, cwd, env: childEnv(deps.env) });
  const requestId = `agentpwa-probe-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, res?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.stdin.end();
      // 応答を受けたら待たずに終わらせる（プロセスは入力の終わりでも終了する）
      if (proc.exitCode === null) proc.kill();
      if (err) reject(err);
      else resolve(res ?? {});
    };
    const timer = setTimeout(() => finish(new Error('claude CLI から応答がありません')), PROBE_TIMEOUT_MS);
    proc.on('error', (e) => finish(e));
    proc.on('exit', () => finish(new Error('claude CLI が終了しました')));
    proc.stdin.on('error', () => {
      /* 終了時の EPIPE は exit で扱う */
    });
    proc.stderr.resume();
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const r = msg?.type === 'control_response' ? msg.response : undefined;
      if (!r || r.request_id !== requestId) return;
      if (r.subtype === 'success') finish(null, r.response ?? {});
      else finish(new Error(String(r.error ?? '失敗しました')));
    });
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n');
  });
}
