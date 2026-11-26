// Codex CLI を PATH から見つけられるようにする。
// Windows の Codex デスクトップアプリは codex.exe を版ごとのフォルダ（C:\Program Files\WindowsApps\OpenAI.Codex_<版>_...\app\resources）
// に置き、アプリが更新されると古いフォルダは消える。Hub が起動時に引き継いだ PATH のままだと、更新のあと codex が見つからなくなるので、
// Codex を確認・起動する直前に PATH を直す。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDriver } from '@agentpwa/shared';

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
}

/** PATH のどこかに codex の実行ファイルがあるか */
export function codexOnPath(pathValue: string): boolean {
  return pathValue.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, EXE)));
}

/** Codex デスクトップアプリ（MSIX）のいまの版の codex.exe があるフォルダ。見つからなければ undefined */
export function findCodexAppDir(): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name OpenAI.Codex).InstallLocation'],
      { timeout: 15_000, windowsHide: true }, (error, stdout) => {
        const loc = error ? '' : stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
        const dir = loc ? path.join(loc, 'app', 'resources') : '';
        resolve(dir && fs.existsSync(path.join(dir, EXE)) ? dir : undefined);
      });
  });
}

/**
 * env の PATH を直す。消えた Codex アプリのフォルダを外し、codex が見つからなければアプリのいまのフォルダを先頭に足す。
 * 直したら true。
 */
export async function refreshCodexPath(env: NodeJS.ProcessEnv, findAppDir = findCodexAppDir): Promise<boolean> {
  const key = pathKey(env);
  const before = env[key] ?? '';
  const dirs = before.split(path.delimiter).filter((d) => !(/[\\/]OpenAI\.Codex_[^\\/]*[\\/]/i.test(d) && !fs.existsSync(d)));
  if (!codexOnPath(dirs.join(path.delimiter))) {
    const appDir = await findAppDir();
    if (appDir) dirs.unshift(appDir);
  }
  const after = dirs.join(path.delimiter);
  if (after === before) return false;
  env[key] = after;
  return true;
}

/** Codex Driver の確認と起動の前に、Hub の PATH を直す */
export function withCodexPath(driver: AgentDriver, refresh: () => Promise<unknown> = () => refreshCodexPath(process.env)): AgentDriver {
  return {
    ...driver,
    async checkAuth() {
      await refresh();
      return driver.checkAuth();
    },
    async start(opts, emit) {
      await refresh();
      return driver.start(opts, emit);
    },
  };
}
