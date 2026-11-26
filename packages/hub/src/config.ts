// Hub の設定ファイル（マシンごと）。既定の場所は ~/.agentpwa/config.json。
// 環境変数 AGENTPWA_CONFIG で別のファイルを指定できる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type AgentKind, type PermissionMode } from '@agentpwa/shared';
import type { FolderEntry, ProjectColor, ProjectTag } from './api.ts';

/** プロジェクトに付けられる色（api.ts の ProjectColor と同じ並び） */
export const PROJECT_COLORS: readonly ProjectColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/** # の候補の数と長さの上限 */
export const MAX_TAGS = 500;
const MAX_TAG_NAME = 64;
const MAX_TAG_DESCRIPTION = 200;

/**
 * # の候補を確かめて、そろえた形（名前は全角を半角にして前後の空白と先頭の # を除き、空の説明は省く）にする。
 * 誤りがあれば、その説明の文字列を返す。名前が重なったら後のものを捨てる。
 */
export function normalizeTags(value: unknown): ProjectTag[] | string {
  if (!Array.isArray(value)) return 'tags は { name, description? } の配列にしてください';
  if (value.length > MAX_TAGS) return `tags は ${MAX_TAGS} 件までにしてください`;
  const out: ProjectTag[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    const t = (typeof v === 'string' ? { name: v } : v) as { name?: unknown; description?: unknown } | null;
    if (typeof t?.name !== 'string') return `tags の name は文字列にしてください: ${JSON.stringify(v)}`;
    // 日本語入力で打った全角の英数字（Ｊ０１）は半角にそろえる
    const name = t.name.normalize('NFKC').trim().replace(/^#+/, '');
    if (!name || /[\s#＃]/.test(name) || name.length > MAX_TAG_NAME) {
      return `tags の name は空白と # を含まない ${MAX_TAG_NAME} 文字までの文字列にしてください: ${JSON.stringify(t.name)}`;
    }
    if (t.description !== undefined && t.description !== null && typeof t.description !== 'string') {
      return `tags の description は文字列にしてください: ${name}`;
    }
    const description = typeof t.description === 'string' ? t.description.trim().slice(0, MAX_TAG_DESCRIPTION) : '';
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(description ? { name, description } : { name });
  }
  return out;
}

export interface HubConfig {
  /** 待ち受けポート（127.0.0.1 固定） */
  port: number;
  /** 一覧に出すマシン名 */
  machineName: string;
  /** 許可する Tailscale ユーザー（Tailscale-User-Login の値。例: you@example.com） */
  allowedUsers: string[];
  /** このPCのブラウザから http://127.0.0.1:<port> で直接開くのを許すか */
  allowLocalhost: boolean;
  /** セッションを起動してよいフォルダ（許可リスト）。画面から作ったプロジェクトもここに書き足す */
  folders: FolderEntry[];
  /** 画面からプロジェクトを作ってよいルートフォルダ（絶対パス）。空なら画面からは作れない */
  projectRoots: string[];
  /** プロジェクトのフォルダのほかに、ファイルビュワーで開いてよいフォルダ（絶対パス）。パソコン版 Google ドライブは自動で加わる */
  viewerRoots?: string[];
  /** claude CLI のパス（省略時は PATH と ~/.local/bin を探す） */
  claudePath?: string;
  /** Codex タブの Driver。'fake' はフィクスチャを流すだけの表示確認用 */
  codex: 'fake' | 'driver';
  /** codex CLI のパス（省略時は PATH を探し、無ければ Codex デスクトップアプリのいまの版の codex.exe を使う） */
  codexPath?: string;
  /** SQLite などを置くフォルダ */
  dataDir: string;
}

export interface LoadedConfig {
  config: HubConfig;
  path: string;
  created: boolean;
}

export function defaultConfigPath(): string {
  return process.env.AGENTPWA_CONFIG || path.join(os.homedir(), '.agentpwa', 'config.json');
}

function defaults(configPath: string): HubConfig {
  return {
    port: 8787,
    machineName: os.hostname(),
    allowedUsers: [],
    allowLocalhost: true,
    folders: [],
    projectRoots: [],
    codex: 'fake',
    dataDir: path.dirname(configPath),
  };
}

function validate(c: HubConfig, file: string): HubConfig {
  const errors: string[] = [];
  if (!Number.isInteger(c.port) || c.port <= 0 || c.port > 65535) errors.push('port が不正です');
  if (!Array.isArray(c.allowedUsers)) errors.push('allowedUsers は配列にしてください');
  if (!Array.isArray(c.folders)) errors.push('folders は配列にしてください');
  for (const f of c.folders ?? []) {
    if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path)) errors.push(`folders のパスは絶対パスにしてください: ${JSON.stringify(f)}`);
  }
  if (!Array.isArray(c.projectRoots)) errors.push('projectRoots は配列にしてください');
  for (const r of c.projectRoots ?? []) {
    if (typeof r !== 'string' || !path.isAbsolute(r)) errors.push(`projectRoots は絶対パスにしてください: ${JSON.stringify(r)}`);
  }
  if (c.viewerRoots !== undefined && (!Array.isArray(c.viewerRoots) || c.viewerRoots.some((r) => typeof r !== 'string' || !path.isAbsolute(r)))) {
    errors.push('viewerRoots は絶対パスの配列にしてください');
  }
  if (c.codex !== 'fake' && c.codex !== 'driver') errors.push("codex は 'fake' か 'driver' にしてください");
  if (c.codexPath !== undefined && typeof c.codexPath !== 'string') errors.push('codexPath は文字列にしてください');
  if (errors.length) throw new Error(`設定ファイル ${file} の誤り:\n- ${errors.join('\n- ')}`);
  for (const f of c.folders ?? []) {
    const label = f.name ?? f.path;
    if (f.agent !== undefined && f.agent !== 'claude' && f.agent !== 'codex') errors.push(`folders の agent は 'claude' か 'codex' にしてください: ${label}`);
    if (f.allowFullAuto !== undefined && typeof f.allowFullAuto !== 'boolean') errors.push(`folders の allowFullAuto は true か false にしてください: ${label}`);
    if (f.defaultPermissionMode !== undefined && !PERMISSION_MODES.includes(f.defaultPermissionMode)) {
      errors.push(`folders の defaultPermissionMode は ${PERMISSION_MODES.map((m) => `'${m}'`).join(' / ')} のどれかにしてください: ${label}`);
    }
    if (f.color !== undefined && !PROJECT_COLORS.includes(f.color)) {
      errors.push(`folders の color は ${PROJECT_COLORS.map((c) => `'${c}'`).join(' / ')} のどれかにしてください: ${label}`);
    }
    if (f.tags !== undefined) {
      const tags = normalizeTags(f.tags);
      if (typeof tags === 'string') errors.push(`folders の ${tags}: ${label}`);
      else f.tags = tags;
    }
    if (f.defaultPermissionMode === 'full_auto' && f.allowFullAuto !== true) {
      errors.push(`defaultPermissionMode を 'full_auto' にするには allowFullAuto: true が必要です: ${label}`);
    }
  }
  // 同じフォルダは AI ごとに1つまで（Claude と Codex で1つずつは登録できる）
  const seen = new Set<string>();
  for (const f of c.folders ?? []) {
    const key = `${f.agent ?? 'claude'}|${norm(f.path)}`;
    if (seen.has(key)) errors.push(`folders に同じフォルダと AI の組が2つあります: ${f.name ?? f.path}（${f.agent ?? 'claude'}）`);
    seen.add(key);
  }
  if (errors.length) throw new Error(`設定ファイル ${file} の誤り:\n- ${errors.join('\n- ')}`);
  // agent を省略したプロジェクトは Claude、full_auto は許さない、既定の権限モードは DEFAULT_PERMISSION_MODE（自動承認）とする
  c.folders = c.folders.map((f) => ({
    name: f.name || path.basename(f.path),
    path: path.resolve(f.path),
    agent: f.agent ?? 'claude',
    allowFullAuto: f.allowFullAuto === true,
    defaultPermissionMode: f.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE,
    ...(f.color ? { color: f.color } : {}),
    ...(f.tags?.length ? { tags: f.tags } : {}),
  }));
  c.projectRoots = c.projectRoots.map((r) => path.resolve(r));
  return c;
}

/** 設定を読む。無ければ既定値で作る。 */
export function loadConfig(file = defaultConfigPath()): LoadedConfig {
  let created = false;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { dataDir: _d, ...initial } = defaults(file);
    fs.writeFileSync(file, JSON.stringify(initial, null, 2) + '\n');
    created = true;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HubConfig>;
  const config = validate({ ...defaults(file), ...raw }, file);
  if (process.env.AGENTPWA_PORT) config.port = Number(process.env.AGENTPWA_PORT);
  return { config, path: file, created };
}

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * 許可リストに入っているフォルダなら、その項目を返す（完全一致のみ。サブフォルダは不可）。
 * 同じフォルダを Claude と Codex の両方のプロジェクトとして登録できるので、agent を渡すとその AI のプロジェクトだけを探す。
 * agent を省くと、そのフォルダの最初のプロジェクト。
 */
export function findAllowedFolder(config: HubConfig, cwd: string, agent?: AgentKind): FolderEntry | undefined {
  const target = norm(cwd);
  return config.folders.find((f) => norm(f.path) === target && (!agent || f.agent === agent));
}

/**
 * このプロジェクト（フォルダと AI の組）のセッションで、その権限モードを使ってよいか。
 * full_auto は、許可リストで allowFullAuto: true にしたプロジェクトだけ。それ以外のモードは制限しない。
 */
export function isModeAllowed(config: HubConfig, cwd: string, agent: AgentKind, mode: PermissionMode): boolean {
  if (mode !== 'full_auto') return true;
  return findAllowedFolder(config, cwd, agent)?.allowFullAuto === true;
}

/**
 * 設定ファイルの変更を見張り、再起動なしで反映できる項目（folders / projectRoots / allowedUsers / allowLocalhost / machineName）を
 * config に書き戻す。port・claudePath・codex・codexPath・dataDir の変更は Hub の再起動が必要。
 */
export function watchConfig(file: string, config: HubConfig, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const reload = () => {
    try {
      const next = loadConfig(file).config;
      config.folders = next.folders;
      config.projectRoots = next.projectRoots;
      config.allowedUsers = next.allowedUsers;
      config.allowLocalhost = next.allowLocalhost;
      config.machineName = next.machineName;
      console.log(`[hub] 設定を読み直しました（フォルダ ${config.folders.length} 件）`);
      onChange();
    } catch (e) {
      console.warn(`[hub] 設定を読み直せませんでした: ${(e as Error).message}`);
    }
  };
  // エディタはファイルを置き換えて保存することがあるので、フォルダごと見張る
  const watcher = fs.watch(path.dirname(file), (_ev, name) => {
    if (name && path.basename(file) !== name.toString()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, 300);
  });
  return () => watcher.close();
}
