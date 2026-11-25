// 入力欄の @ の候補（セッションの作業フォルダの下のファイルとフォルダ）。
// git の作業ツリーなら git ls-files（.gitignore で外したものは出さない）、そうでなければフォルダをたどって集める。
// 一覧は作業フォルダごとにしばらく覚えておき、絞り込みは毎回ここで行う。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MentionItem } from './api.ts';

const execFileAsync = promisify(execFile);

/** 覚えておく時間 */
const TTL_MS = 30_000;
/** 集めるファイルの数の上限（大きすぎるフォルダで止まらないように） */
const MAX_FILES = 50_000;
/** git でないフォルダをたどるときの深さの上限 */
const MAX_DEPTH = 8;
/** git でないフォルダをたどるときに入らないフォルダ */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'bin', 'obj']);

type Entry = { items?: MentionItem[]; promise?: Promise<MentionItem[]>; at: number };
const cache = new Map<string, Entry>();

/** ファイルのパスの一覧から、ファイルとその上のフォルダの候補を作る */
function toItems(files: string[]): MentionItem[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const d = f.slice(0, i + 1);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = f.lastIndexOf('/', i - 1);
    }
  }
  return [...[...dirs].map((p) => ({ path: p, kind: 'dir' as const })), ...files.map((p) => ({ path: p, kind: 'file' as const }))];
}

async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: 15_000,
    });
    return stdout.split('\0').filter(Boolean).slice(0, MAX_FILES);
  } catch {
    return null;
  }
}

async function walkFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  await walk(cwd, '', 0);
  return out;
}

async function load(cwd: string): Promise<MentionItem[]> {
  const isGit = fs.existsSync(path.join(cwd, '.git'));
  const files = (isGit ? await gitFiles(cwd) : null) ?? (await walkFiles(cwd));
  return toItems(files);
}

/** 作業フォルダの候補の一覧（覚えておいたものがあれば、それを使う） */
export function listMentions(cwd: string): Promise<MentionItem[]> {
  const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  const e = cache.get(key);
  if (e?.items && Date.now() - e.at < TTL_MS) return Promise.resolve(e.items);
  if (e?.promise) return e.promise;
  const entry: Entry = { items: e?.items, at: e?.at ?? 0 };
  entry.promise = load(cwd)
    .then((items) => {
      entry.items = items;
      entry.at = Date.now();
      return items;
    })
    .finally(() => {
      entry.promise = undefined;
    });
  cache.set(key, entry);
  return entry.promise;
}

/** query の文字が順に（飛び飛びでも）text に現れるか */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return query.length === 0;
}

/**
 * 候補を絞り込んで並べる。名前の前方一致 → 名前の部分一致 → パスの部分一致 → パスのあいまい一致の順。
 * 同じ順位なら浅い（短い）パスを先にする。空のときは作業フォルダの直下だけを出す。
 */
export function filterMentions(items: MentionItem[], query: string, limit = 50): MentionItem[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  if (!q) {
    return items
      .filter((it) => !it.path.replace(/\/$/, '').includes('/'))
      .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1))
      .slice(0, limit);
  }
  const scored: { it: MentionItem; rank: number }[] = [];
  for (const it of items) {
    const p = it.path.toLowerCase();
    // 打ち終わったフォルダそのもの（選んだ直後の「src/」など）は出さない
    if (p === q) continue;
    const trimmed = p.replace(/\/$/, '');
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    let rank: number;
    if (q.includes('/')) {
      if (p.startsWith(q)) rank = 0;
      else if (p.includes(q)) rank = 2;
      else if (isSubsequence(q, p)) rank = 3;
      else continue;
    } else if (name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (p.includes(q)) rank = 2;
    else if (isSubsequence(q, name)) rank = 3;
    else continue;
    scored.push({ it, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.it.path.length - b.it.path.length || a.it.path.localeCompare(b.it.path));
  return scored.slice(0, limit).map((s) => s.it);
}
