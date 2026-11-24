// ファイルビュワー用のファイル配信（docs/architecture.md の 5.1 と 6.7）。
// セッションのプロジェクトのフォルダの下と、追加で見てよいフォルダ（Google ドライブ、設定の viewerRoots）の下の
// ファイルだけを返す。フォルダの一覧は返さない。
// いまは Hub と同じPC（local）のプロジェクトだけ。SSH 先のマシンは起動役を通して読む（フェーズ3）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileInfo, FileKind } from './api.ts';
import type { HubConfig } from './config.ts';
import { isInside } from './projects.ts';
import { HttpError } from './sessions.ts';

/** 拡張子ごとの Content-Type と、ビュワーでの表示のしかた */
const TYPES: Record<string, { mime: string; kind: FileKind }> = {
  '.html': { mime: 'text/html; charset=utf-8', kind: 'html' },
  '.htm': { mime: 'text/html; charset=utf-8', kind: 'html' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.avif': { mime: 'image/avif', kind: 'image' },
  '.svg': { mime: 'image/svg+xml', kind: 'image' },
  '.ico': { mime: 'image/x-icon', kind: 'image' },
  '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  '.mp4': { mime: 'video/mp4', kind: 'media' },
  '.webm': { mime: 'video/webm', kind: 'media' },
  '.mov': { mime: 'video/quicktime', kind: 'media' },
  '.mp3': { mime: 'audio/mpeg', kind: 'media' },
  '.m4a': { mime: 'audio/mp4', kind: 'media' },
  '.wav': { mime: 'audio/wav', kind: 'media' },
  '.ogg': { mime: 'audio/ogg', kind: 'media' },
  '.md': { mime: 'text/markdown; charset=utf-8', kind: 'markdown' },
  '.markdown': { mime: 'text/markdown; charset=utf-8', kind: 'markdown' },
  // HTML から読まれるもの（iframe の中で正しく読めるように型を付ける）
  '.css': { mime: 'text/css; charset=utf-8', kind: 'text' },
  '.js': { mime: 'text/javascript; charset=utf-8', kind: 'text' },
  '.mjs': { mime: 'text/javascript; charset=utf-8', kind: 'text' },
  '.json': { mime: 'application/json; charset=utf-8', kind: 'text' },
  '.txt': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.csv': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.xml': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.woff': { mime: 'font/woff', kind: 'binary' },
  '.woff2': { mime: 'font/woff2', kind: 'binary' },
  '.ttf': { mime: 'font/ttf', kind: 'binary' },
  '.otf': { mime: 'font/otf', kind: 'binary' },
  '.wasm': { mime: 'application/wasm', kind: 'binary' },
};

/** 文字のファイルかを、先頭 8KB に NUL があるかで見分ける */
async function looksText(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return !buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

const MY_DRIVE = ['マイドライブ', 'My Drive'];
let gdriveCache: { at: number; roots: string[] } | undefined;

/**
 * パソコン版 Google ドライブのフォルダを探す（Windows のみ）。
 * ストリーミングでは、直下に「マイドライブ」（My Drive）があるドライブを、ドライブごと（共有ドライブも含む）加える。
 * ミラーリングでは、ホームの下の「マイドライブ」（My Drive）を加える。
 * Google ドライブは Hub より後に起動することがあるので、1分ごとに探し直す。
 */
export function googleDriveRoots(): string[] {
  if (process.platform !== 'win32') return [];
  if (gdriveCache && Date.now() - gdriveCache.at < 60_000) return gdriveCache.roots;
  const roots: string[] = [];
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (MY_DRIVE.some((n) => fs.existsSync(path.join(root, n)))) roots.push(root);
  }
  for (const n of MY_DRIVE) {
    const mirror = path.join(os.homedir(), n);
    if (fs.existsSync(mirror)) roots.push(mirror);
  }
  gdriveCache = { at: Date.now(), roots };
  return roots;
}

/** プロジェクトのフォルダのほかに、ビュワーで開いてよいフォルダ（設定の viewerRoots と Google ドライブ） */
export function extraViewerRoots(config: Pick<HubConfig, 'viewerRoots'>): string[] {
  return [...(config.viewerRoots ?? []), ...googleDriveRoots()];
}

export interface ResolvedFile {
  /** 実パス */
  real: string;
  /** プロジェクトのフォルダからの相対パス（区切りは /）。プロジェクトの外（追加のフォルダの下）なら絶対パス（区切りは /） */
  rel: string;
  size: number;
  mtime: string;
  mime: string;
  kind: FileKind;
}

/**
 * プロジェクトのフォルダ（cwd）か extraRoots の下のファイルを探す。p は cwd からの相対パスか絶対パス。
 * シンボリックリンクを解決したうえで、どのフォルダの外にも出ていないかを確かめる。
 */
export async function resolveProjectFile(cwd: string, p: string, extraRoots: string[] = []): Promise<ResolvedFile> {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new HttpError(400, 'ファイルのパスを指定してください');
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(cwd);
  } catch {
    throw new HttpError(404, `プロジェクトのフォルダが見つかりません: ${cwd}`);
  }
  const extras: { given: string; real: string }[] = [];
  for (const r of extraRoots) {
    try {
      extras.push({ given: path.resolve(r), real: await fs.promises.realpath(r) });
    } catch {
      // 見つからないフォルダ（外したドライブなど）は使わない
    }
  }
  // 先に字面で確かめる（..、別のドライブ、UNC パスなど）
  const target = path.resolve(cwd, p);
  const allowed =
    isInside(path.resolve(cwd), target) || isInside(realRoot, target) || extras.some((r) => isInside(r.given, target) || isInside(r.real, target));
  if (!allowed) throw new HttpError(403, `プロジェクトのフォルダの外のファイルは開けません: ${p}`);
  let real: string;
  try {
    real = await fs.promises.realpath(target);
  } catch {
    throw new HttpError(404, `ファイルが見つかりません: ${p}`);
  }
  const inProject = isInside(realRoot, real);
  if (!inProject && !extras.some((r) => isInside(r.real, real))) throw new HttpError(403, `プロジェクトのフォルダの外のファイルは開けません: ${p}`);
  const st = await fs.promises.stat(real);
  if (!st.isFile()) throw new HttpError(400, `ファイルではありません: ${p}`);
  // プロジェクトの外のファイルは、絶対パスのまま返す（Web はこれを /files/ の URL に使う）
  const rel = (inProject ? path.relative(realRoot, real) : real).split(path.sep).join('/');
  const ext = path.extname(real).toLowerCase();
  let t = TYPES[ext];
  if (!t) t = (await looksText(real)) ? { mime: 'text/plain; charset=utf-8', kind: 'text' } : { mime: 'application/octet-stream', kind: 'binary' };
  return { real, rel, size: st.size, mtime: st.mtime.toISOString(), mime: t.mime, kind: t.kind };
}

export function toInfo(f: ResolvedFile): FileInfo {
  return { path: f.rel, size: f.size, mtime: f.mtime, kind: f.kind, mime: f.mime };
}

/**
 * /files/ の応答に付けるヘッダー。HTML などの中のスクリプトは、URL を直接開いたときも
 * 別のオリジン扱い（CSP の sandbox。allow-same-origin は付けない）にして、Hub の API や PWA の保存データに触れさせない。
 * PDF だけは、sandbox にするとブラウザ内蔵の PDF 表示が動かないため外す（PDF の中身はブラウザ側で隔離される）。
 */
export function fileHeaders(f: ResolvedFile): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': f.mime,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  if (f.kind !== 'pdf') h['content-security-policy'] = 'sandbox allow-scripts allow-popups';
  return h;
}
