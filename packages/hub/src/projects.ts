// 画面からのプロジェクト作成（このPCだけ。SSH 先のマシンは後のフェーズ）。
// フォルダは設定ファイルの projectRoots の下に限る。作ったプロジェクトは設定ファイルの folders に書き足す
// （docs/architecture.md の 6.3。保存先を SQLite に移すのはフェーズ3）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type AgentKind } from '@agentpwa/shared';
import type { CreateProjectRequest, DirListing, FolderEntry } from './api.ts';
import { findAllowedFolder, type HubConfig } from './config.ts';
import { HttpError } from './sessions.ts';

const execFileAsync = promisify(execFile);
const AGENTS: AgentKind[] = ['claude', 'codex'];

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** child が root と同じか、その下にあるか（どちらも実パスで渡す） */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(norm(root), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realDir(p: string): Promise<string> {
  let real: string;
  try {
    real = await fs.promises.realpath(p);
  } catch {
    throw new HttpError(404, `フォルダが見つかりません: ${p}`);
  }
  const st = await fs.promises.stat(real);
  if (!st.isDirectory()) throw new HttpError(400, `フォルダではありません: ${p}`);
  return real;
}

/** ルートフォルダの実パス（存在しないルートは除く） */
async function realRoots(config: HubConfig): Promise<{ root: string; real: string }[]> {
  const out: { root: string; real: string }[] = [];
  for (const root of config.projectRoots) {
    try {
      out.push({ root, real: await fs.promises.realpath(root) });
    } catch {
      /* 無いルートは見せない */
    }
  }
  return out;
}

/**
 * パスを実パスにして（シンボリックリンクを解決して）、どれかのルートの下にあることを確かめる。
 * 戻り値は実パスと、それを含むルートの実パス。
 */
export async function resolveInsideRoots(config: HubConfig, p: string): Promise<{ real: string; root: string }> {
  if (config.projectRoots.length === 0) {
    throw new HttpError(400, '画面からプロジェクトを作るには、設定ファイルの projectRoots にルートフォルダを書いてください');
  }
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new HttpError(400, 'フォルダは絶対パスで指定してください');
  const real = await realDir(path.resolve(p));
  const root = (await realRoots(config)).find((r) => isInside(r.real, real));
  if (!root) throw new HttpError(403, `ルートフォルダ（projectRoots）の外のフォルダは使えません: ${p}`);
  return { real, root: root.real };
}

/** フォルダの中のサブフォルダを並べる。p を省くとルートフォルダの一覧 */
export async function listDirs(config: HubConfig, p?: string): Promise<DirListing> {
  const registered = (dir: string) => findAllowedFolder(config, dir) !== undefined;
  if (!p) {
    const roots = await realRoots(config);
    return { entries: roots.map((r) => ({ name: r.root, path: r.real, registered: registered(r.real) })) };
  }
  const { real, root } = await resolveInsideRoots(config, p);
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(real, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(403, `フォルダを読めません: ${(e as Error).message}`);
  }
  const entries = dirents
    // 隠しフォルダ（.git など）と Windows のシステムフォルダ（$RECYCLE.BIN など）は出さない。
    // シンボリックリンクは外に出られるので一覧に出さない（パスを直接指定した場合も resolveInsideRoots で弾く）
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'))
    .map((d) => {
      const full = path.join(real, d.name);
      return { name: d.name, path: full, registered: registered(full) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const parent = norm(root) !== norm(real) ? path.dirname(real) : undefined;
  return { path: real, parent, entries };
}

/** 新しく作るフォルダの名前として使えるか（区切り文字や Windows で使えない文字を含まない） */
export function validFolderName(name: string): boolean {
  if (!name || name !== name.trim() || name.length > 200) return false;
  if (name === '.' || name === '..' || name.endsWith('.')) return false;
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return false;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return false;
  return true;
}

export interface ProjectDeps {
  config: HubConfig;
  configPath: string;
  /** その AI が使えるか（CLI があってログイン済みか） */
  agentAvailable: (agent: AgentKind) => Promise<boolean>;
  /** 設定が変わったことを各端末に知らせる */
  onChanged: () => void;
}

// 設定ファイルへの書き込みを1件ずつにする
let queue: Promise<unknown> = Promise.resolve();

export function createProject(deps: ProjectDeps, body: Partial<CreateProjectRequest>): Promise<FolderEntry> {
  const run = queue.then(() => doCreate(deps, body));
  queue = run.catch(() => undefined);
  return run;
}

async function doCreate(deps: ProjectDeps, b: Partial<CreateProjectRequest>): Promise<FolderEntry> {
  const { config } = deps;
  if (b.mode !== 'existing' && b.mode !== 'new') throw new HttpError(400, '作り方（mode）が正しくありません');
  if (!b.agent || !AGENTS.includes(b.agent)) throw new HttpError(400, '使う AI を選んでください');
  if (b.defaultPermissionMode !== undefined && !PERMISSION_MODES.includes(b.defaultPermissionMode)) throw new HttpError(400, '既定の権限モードが正しくありません');
  if (b.allowFullAuto !== undefined && typeof b.allowFullAuto !== 'boolean') throw new HttpError(400, 'allowFullAuto が正しくありません');
  if (b.defaultPermissionMode === 'full_auto' && b.allowFullAuto !== true) throw new HttpError(400, '既定を「すべて自動」にするには、「すべて自動」を許可してください');
  if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 100)) throw new HttpError(400, '名前が正しくありません');
  if (typeof b.path !== 'string') throw new HttpError(400, 'フォルダを指定してください');
  if (!(await deps.agentAvailable(b.agent))) throw new HttpError(400, `${b.agent} はこのマシンで使えません（CLI が無いか、ログインしていません）`);

  let dir: string;
  if (b.mode === 'existing') {
    dir = (await resolveInsideRoots(config, b.path)).real;
  } else {
    const folderName = typeof b.folderName === 'string' ? b.folderName : '';
    if (!validFolderName(folderName)) throw new HttpError(400, `フォルダ名に使えない文字が含まれています: ${folderName}`);
    const parent = (await resolveInsideRoots(config, b.path)).real;
    dir = path.join(parent, folderName);
    if (findAllowedFolder(config, dir)) throw new HttpError(409, `すでに登録済みのプロジェクトです: ${dir}`);
    try {
      await fs.promises.mkdir(dir); // recursive にしない（既にあれば失敗させる）
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new HttpError(code === 'EEXIST' ? 409 : 500, code === 'EEXIST' ? `同じ名前のフォルダがすでにあります: ${dir}` : `フォルダを作れません: ${(e as Error).message}`);
    }
    if (b.gitInit) {
      try {
        await execFileAsync('git', ['init'], { cwd: dir, windowsHide: true, timeout: 30_000 });
      } catch (e) {
        // フォルダは作れたので、登録は続ける（git init はあとから自分でできる）
        console.warn(`[hub] git init に失敗しました（${dir}）: ${(e as Error).message}`);
      }
    }
  }
  if (findAllowedFolder(config, dir)) throw new HttpError(409, `すでに登録済みのプロジェクトです: ${dir}`);

  const entry: FolderEntry = {
    name: b.name?.trim() || path.basename(dir),
    path: dir,
    agent: b.agent,
    allowFullAuto: b.allowFullAuto === true,
    defaultPermissionMode: b.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE,
  };
  await appendFolderToConfig(deps.configPath, entry);
  // 監視による読み直しを待たずに反映する（読み直しでも同じ内容になる）
  config.folders = [...config.folders, entry];
  deps.onChanged();
  return entry;
}

/** 設定ファイルの folders に1件書き足す。ほかの項目はそのまま残す。一時ファイルに書いてから置き換える */
export async function appendFolderToConfig(configPath: string, entry: FolderEntry): Promise<void> {
  const raw = JSON.parse(await fs.promises.readFile(configPath, 'utf8')) as Record<string, unknown>;
  const folders = Array.isArray(raw.folders) ? raw.folders : [];
  const item: Record<string, unknown> = { name: entry.name, path: entry.path, agent: entry.agent };
  if (entry.allowFullAuto) item.allowFullAuto = true;
  if (entry.defaultPermissionMode && entry.defaultPermissionMode !== DEFAULT_PERMISSION_MODE) item.defaultPermissionMode = entry.defaultPermissionMode;
  raw.folders = [...folders, item];
  const tmp = `${configPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(raw, null, 2) + '\n');
  await fs.promises.rename(tmp, configPath);
}
