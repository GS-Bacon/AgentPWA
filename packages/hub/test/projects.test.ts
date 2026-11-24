// 画面からのプロジェクト作成（ルートフォルダの確認、設定ファイルへの書き足し）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { createProject, isInside, listDirs, reorderProjects, updateProject, validFolderName, type ProjectDeps } from '../src/projects.ts';

let dir: string;
let root: string;
let configPath: string;
let config: HubConfig;
let changed: number;
let available: boolean;

function deps(): ProjectDeps {
  return { config, configPath, agentAvailable: async () => available, onChanged: () => changed++ };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-proj-')));
  root = path.join(dir, 'work');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(dir, 'outside'));
  configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ allowedUsers: ['me@example.com'], folders: [{ path: path.join(root, 'alpha') }], projectRoots: [root] }, null, 2));
  config = loadConfig(configPath).config;
  changed = 0;
  available = true;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('フォルダの一覧', () => {
  it('path を省くとルートフォルダを返す', async () => {
    const l = await listDirs(config);
    expect(l.path).toBeUndefined();
    expect(l.entries.map((e) => e.path)).toEqual([root]);
  });

  it('サブフォルダを並べ、隠しフォルダは出さず、登録済みに印を付ける', async () => {
    const l = await listDirs(config, root);
    expect(l.parent).toBeUndefined();
    expect(l.entries.map((e) => [e.name, e.registered])).toEqual([
      ['alpha', true],
      ['beta', false],
    ]);
    const sub = await listDirs(config, path.join(root, 'beta'));
    expect(sub.parent).toBe(root);
  });

  it('ルートの外は見られない', async () => {
    await expect(listDirs(config, path.join(dir, 'outside'))).rejects.toThrow('ルートフォルダ');
    await expect(listDirs(config, path.join(root, '..', 'outside'))).rejects.toThrow('ルートフォルダ');
    await expect(listDirs(config, dir)).rejects.toThrow('ルートフォルダ');
  });

  it('ルートを決めていなければ使えない', async () => {
    config.projectRoots = [];
    await expect(listDirs(config, root)).rejects.toThrow('projectRoots');
  });

  it('外を指すシンボリックリンクはたどれない', async () => {
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(path.join(dir, 'outside'), link, 'junction');
    } catch {
      return; // 権限がなくリンクを作れない環境では確かめない
    }
    expect((await listDirs(config, root)).entries.map((e) => e.name)).not.toContain('link');
    await expect(listDirs(config, link)).rejects.toThrow('ルートフォルダ');
    await expect(createProject(deps(), { mode: 'existing', path: link, agent: 'claude' })).rejects.toThrow('ルートフォルダ');
  });
});

describe('プロジェクトの作成', () => {
  it('既存のフォルダを登録し、設定ファイルの folders に書き足す', async () => {
    const f = await createProject(deps(), { mode: 'existing', path: path.join(root, 'beta'), agent: 'codex', name: 'ベータ' });
    expect(f).toMatchObject({ name: 'ベータ', path: path.join(root, 'beta'), agent: 'codex', allowFullAuto: false, defaultPermissionMode: 'auto' });
    expect(config.folders).toHaveLength(2);
    expect(changed).toBe(1);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.allowedUsers).toEqual(['me@example.com']);
    expect(raw.folders[1]).toEqual({ name: 'ベータ', path: path.join(root, 'beta'), agent: 'codex' });
    // 読み直しても同じ内容になる
    expect(loadConfig(configPath).config.folders[1]).toEqual(f);
  });

  it('新しいフォルダを作って登録する', async () => {
    const f = await createProject(deps(), { mode: 'new', path: root, folderName: 'gamma', agent: 'claude', allowFullAuto: true, defaultPermissionMode: 'full_auto' });
    expect(fs.statSync(path.join(root, 'gamma')).isDirectory()).toBe(true);
    expect(f).toMatchObject({ name: 'gamma', allowFullAuto: true, defaultPermissionMode: 'full_auto' });
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.folders[1]).toMatchObject({ allowFullAuto: true, defaultPermissionMode: 'full_auto' });
  });

  it('git init を選ぶと .git ができる', async () => {
    await createProject(deps(), { mode: 'new', path: root, folderName: 'repo', gitInit: true, agent: 'claude' });
    expect(fs.existsSync(path.join(root, 'repo', '.git'))).toBe(true);
  });

  it('登録済み・既にあるフォルダ・使えない名前は断る', async () => {
    await expect(createProject(deps(), { mode: 'existing', path: path.join(root, 'alpha'), agent: 'claude' })).rejects.toThrow('登録済み');
    await expect(createProject(deps(), { mode: 'new', path: root, folderName: 'beta', agent: 'claude' })).rejects.toThrow('すでにあります');
    await expect(createProject(deps(), { mode: 'new', path: root, folderName: '../evil', agent: 'claude' })).rejects.toThrow('使えない文字');
    await expect(createProject(deps(), { mode: 'new', path: path.join(dir, 'outside'), folderName: 'x', agent: 'claude' })).rejects.toThrow('ルートフォルダ');
    expect(fs.existsSync(path.join(dir, 'outside', 'x'))).toBe(false);
    expect(config.folders).toHaveLength(1);
  });

  it('使えない AI と、許可なしの full_auto 既定は断る', async () => {
    await expect(createProject(deps(), { mode: 'existing', path: path.join(root, 'beta'), agent: 'claude', defaultPermissionMode: 'full_auto' })).rejects.toThrow('すべて自動');
    available = false;
    await expect(createProject(deps(), { mode: 'existing', path: path.join(root, 'beta'), agent: 'claude' })).rejects.toThrow('使えません');
  });

  it('同時に作っても設定ファイルの書き足しが失われない', async () => {
    await Promise.all([
      createProject(deps(), { mode: 'new', path: root, folderName: 'p1', agent: 'claude' }),
      createProject(deps(), { mode: 'new', path: root, folderName: 'p2', agent: 'claude' }),
    ]);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // 1件目は手で書いた項目（name なし）のまま残る
    expect(raw.folders.map((f: { name?: string }) => f.name)).toEqual([undefined, 'p1', 'p2']);
  });
});

describe('プロジェクトの並べ替え', () => {
  it('設定ファイルの folders の順を入れ替え、各項目は書かれたまま残す', async () => {
    await createProject(deps(), { mode: 'new', path: root, folderName: 'p1', agent: 'codex' });
    await createProject(deps(), { mode: 'new', path: root, folderName: 'p2', agent: 'claude' });
    const [a, p1, p2] = config.folders.map((f) => f.path);
    changed = 0;
    const res = await reorderProjects(deps(), [p2, a + path.sep, p1]);
    expect(res.map((f) => f.path)).toEqual([p2, a, p1]);
    expect(config.folders.map((f) => f.path)).toEqual([p2, a, p1]);
    expect(changed).toBe(1);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.folders).toEqual([{ name: 'p2', path: p2, agent: 'claude' }, { path: a }, { name: 'p1', path: p1, agent: 'codex' }]);
    expect(raw.allowedUsers).toEqual(['me@example.com']);
    // 読み直しても同じ順になる
    expect(loadConfig(configPath).config.folders.map((f) => f.path)).toEqual([p2, a, p1]);
  });

  it('過不足・重複・形の違う値は断る', async () => {
    await createProject(deps(), { mode: 'new', path: root, folderName: 'p1', agent: 'claude' });
    const [a, p1] = config.folders.map((f) => f.path);
    await expect(reorderProjects(deps(), [a])).rejects.toThrow('一覧が変わっています');
    await expect(reorderProjects(deps(), [a, a])).rejects.toThrow('一覧が変わっています');
    await expect(reorderProjects(deps(), [p1, a, path.join(root, 'beta')])).rejects.toThrow('一覧が変わっています');
    await expect(reorderProjects(deps(), 'x')).rejects.toThrow('paths');
    await expect(reorderProjects(deps(), [1, 2])).rejects.toThrow('paths');
    expect(config.folders.map((f) => f.path)).toEqual([a, p1]);
  });
});

describe('プロジェクトの色', () => {
  it('設定ファイルに color を書き、null で消す。ほかの項目はそのまま', async () => {
    const a = path.join(root, 'alpha');
    const e = await updateProject(deps(), { path: a + path.sep, color: 'teal' });
    expect(e.color).toBe('teal');
    expect(config.folders[0].color).toBe('teal');
    expect(changed).toBe(1);
    let raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.folders).toEqual([{ path: a, color: 'teal' }]);
    expect(loadConfig(configPath).config.folders[0].color).toBe('teal');

    await updateProject(deps(), { path: a, color: null });
    expect(config.folders[0].color).toBeUndefined();
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.folders).toEqual([{ path: a }]);
  });

  it('知らない色や未登録のプロジェクトは断る', async () => {
    const a = path.join(root, 'alpha');
    await expect(updateProject(deps(), { path: a, color: '#ff0000' })).rejects.toThrow('色は');
    await expect(updateProject(deps(), { path: a })).rejects.toThrow('色は');
    await expect(updateProject(deps(), { path: path.join(root, 'beta'), color: 'red' })).rejects.toThrow('登録されていない');
    await expect(updateProject(deps(), { path: 'rel', color: 'red' })).rejects.toThrow('絶対パス');
  });

  it('設定ファイルの color が不正なら読み込みで断る', () => {
    fs.writeFileSync(configPath, JSON.stringify({ folders: [{ path: path.join(root, 'alpha'), color: 'navy' }] }));
    expect(() => loadConfig(configPath)).toThrow('color');
  });
});

describe('補助関数', () => {
  it('ルートの内側かどうか', () => {
    expect(isInside(path.resolve('/a'), path.resolve('/a'))).toBe(true);
    expect(isInside(path.resolve('/a'), path.resolve('/a/b'))).toBe(true);
    expect(isInside(path.resolve('/a'), path.resolve('/ab'))).toBe(false);
    expect(isInside(path.resolve('/a'), path.resolve('/'))).toBe(false);
  });

  it('フォルダ名', () => {
    expect(validFolderName('my-app')).toBe(true);
    expect(validFolderName('日本語')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'con', 'NUL.txt', ' a', 'a.']) expect(validFolderName(bad)).toBe(false);
  });
});
