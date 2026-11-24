// Hub の設定ファイル（マシンごと）。既定の場所は ~/.agentpwa/config.json。
// 環境変数 AGENTPWA_CONFIG で別のファイルを指定できる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FolderEntry } from './api.ts';

export interface HubConfig {
  /** 待ち受けポート（127.0.0.1 固定） */
  port: number;
  /** 一覧に出すマシン名 */
  machineName: string;
  /** 許可する Tailscale ユーザー（Tailscale-User-Login の値。例: you@example.com） */
  allowedUsers: string[];
  /** このPCのブラウザから http://127.0.0.1:<port> で直接開くのを許すか */
  allowLocalhost: boolean;
  /** セッションを起動してよいフォルダ（許可リスト） */
  folders: FolderEntry[];
  /** claude CLI のパス（省略時は PATH と ~/.local/bin を探す） */
  claudePath?: string;
  /** Codex タブの Driver。'fake' はフィクスチャを流すだけの表示確認用 */
  codex: 'fake' | 'driver';
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
  if (c.codex !== 'fake' && c.codex !== 'driver') errors.push("codex は 'fake' か 'driver' にしてください");
  if (errors.length) throw new Error(`設定ファイル ${file} の誤り:\n- ${errors.join('\n- ')}`);
  for (const f of c.folders ?? []) {
    if (f && f.agent !== undefined && f.agent !== 'claude' && f.agent !== 'codex') errors.push(`folders の agent は 'claude' か 'codex' にしてください: ${f.name ?? f.path}`);
  }
  if (errors.length) throw new Error(`設定ファイル ${file} の誤り:\n- ${errors.join('\n- ')}`);
  // agent を省略したプロジェクトは Claude とする
  c.folders = c.folders.map((f) => ({ name: f.name || path.basename(f.path), path: path.resolve(f.path), agent: f.agent ?? 'claude' }));
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

/** 許可リストに入っているフォルダなら、その項目を返す（完全一致のみ。サブフォルダは不可）。 */
export function findAllowedFolder(config: HubConfig, cwd: string): FolderEntry | undefined {
  const target = norm(cwd);
  return config.folders.find((f) => norm(f.path) === target);
}

/**
 * 設定ファイルの変更を見張り、再起動なしで反映できる項目（folders / allowedUsers / allowLocalhost / machineName）を
 * config に書き戻す。port・claudePath・codex・dataDir の変更は Hub の再起動が必要。
 */
export function watchConfig(file: string, config: HubConfig, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const reload = () => {
    try {
      const next = loadConfig(file).config;
      config.folders = next.folders;
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
