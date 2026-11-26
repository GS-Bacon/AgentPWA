import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshCodexPath } from '../src/codex-path.ts';

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';

describe('refreshCodexPath', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function appDir(version: string, withExe = true): string {
    const dir = path.join(root, `OpenAI.Codex_${version}_x64__abc`, 'app', 'resources');
    fs.mkdirSync(dir, { recursive: true });
    if (withExe) fs.writeFileSync(path.join(dir, EXE), '');
    return dir;
  }

  it('アプリの更新で消えた古いフォルダを外し、いまの版のフォルダを先頭に足す', async () => {
    const old = path.join(root, 'OpenAI.Codex_1.0.0_x64__abc', 'app', 'resources');
    const current = appDir('2.0.0');
    const other = path.join(root, 'bin');
    const env: NodeJS.ProcessEnv = { Path: [other, old].join(path.delimiter) };
    expect(await refreshCodexPath(env, async () => current)).toBe(true);
    expect(env.Path).toBe([current, other].join(path.delimiter));
  });

  it('PATH に codex があれば、アプリを探さず何も変えない', async () => {
    const current = appDir('2.0.0');
    const env: NodeJS.ProcessEnv = { PATH: current };
    let asked = false;
    expect(await refreshCodexPath(env, async () => { asked = true; return undefined; })).toBe(false);
    expect(asked).toBe(false);
    expect(env.PATH).toBe(current);
  });

  it('アプリも見つからなければ、消えたフォルダを外すだけにする', async () => {
    const old = path.join(root, 'OpenAI.Codex_1.0.0_x64__abc', 'app', 'resources');
    const env: NodeJS.ProcessEnv = { PATH: [old, root].join(path.delimiter) };
    expect(await refreshCodexPath(env, async () => undefined)).toBe(true);
    expect(env.PATH).toBe(root);
  });
});
