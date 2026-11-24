// 起動役（ProcessLauncher）: claude CLI の子プロセスを、どのマシンで動かすかを Driver から切り離す。
//
// docs/architecture.md の 6.6（v4 の変更案）で共通プロトコルに入れる予定のもの。v4 が入るまでは
// Driver 内に持ち、Hub からは `createClaudeDriver({ launcher })` で渡せるようにしておく。
// 既定は local（このPCで child_process として起動）。ssh は v4 で足す。
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MachineOs = 'windows' | 'linux' | 'macos';

export interface LaunchSpec {
  command: string;
  args: string[];
  /** 作業フォルダ（起動先のマシン上のパス） */
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface RunResult {
  /** 終了コード。コマンドが見つからないときは -1 */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessLauncher {
  /** 起動先のマシンの OS（パスの扱いに使う） */
  readonly os: MachineOs;
  /** 起動先のマシンのホームフォルダ */
  homeDir(): Promise<string>;
  /** 標準入出力をパイプでつないだ子プロセスを起動する */
  spawn(spec: LaunchSpec): ChildProcessWithoutNullStreams;
  /** 短いコマンドを実行して、出力をまとめて受け取る */
  run(spec: LaunchSpec, timeoutMs?: number): Promise<RunResult>;
  /** 起動先のマシンのファイル・フォルダを消す（無ければ何もしない） */
  remove(paths: string[]): Promise<void>;
}

function currentOs(): MachineOs {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/** このPCで子プロセスとして起動する起動役。 */
export function createLocalLauncher(): ProcessLauncher {
  return {
    os: currentOs(),
    async homeDir() {
      return os.homedir();
    },
    spawn(spec) {
      return spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    },
    run(spec, timeoutMs = 20_000) {
      return new Promise((resolve) => {
        execFile(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
          const code = !e ? 0 : e.code === 'ENOENT' ? -1 : typeof e.code === 'number' ? e.code : 1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      });
    },
    async remove(paths) {
      for (const p of paths) fs.rmSync(p, { recursive: true, force: true });
    },
  };
}

/** 起動先の OS に合わせた path モジュール（Hub が Windows でも、Linux のマシンのパスは POSIX として扱う）。 */
export function pathFor(machineOs: MachineOs): path.PlatformPath {
  return machineOs === 'windows' ? path.win32 : path.posix;
}
