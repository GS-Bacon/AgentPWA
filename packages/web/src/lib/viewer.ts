// ファイルビュワー（docs/architecture.md の 5.1）の共通部品。
// 会話の中のパスをタップしたときに openFile() を呼ぶと、iPad / Web はビュワーのペインを、iPhone は全画面のビュワーを開く。
import { relPath } from './format.ts';

type Listener = (sessionId: string, path: string) => void;
const listeners = new Set<Listener>();

/** ファイルをビュワーで開く（開き方は DesktopApp / PhoneApp が決める） */
export function openFile(sessionId: string, path: string): void {
  for (const l of listeners) l(sessionId, path);
}

export function onOpenFile(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Hub の /files/ の URL（相対パスを / ごとに区切ってエンコードする） */
export function fileUrl(sessionId: string, rel: string): string {
  return `/files/${encodeURIComponent(sessionId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** 表示用: プロジェクトのフォルダからの相対パス（区切りは /） */
export function displayPath(p: string, cwd: string): string {
  return relPath(p, cwd).split('\\').join('/');
}

/** 同じファイルを指しているか（Windows のパスは大文字小文字と区切りを区別しない） */
export function samePath(a: string, b: string, cwd: string): boolean {
  const n = (p: string) => displayPath(p, cwd).replace(/^\.\//, '').toLowerCase();
  return n(a) === n(b);
}

const EXT = /\.(html?|md|markdown|txt|json|csv|xml|ya?ml|toml|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|sql|svg|png|jpe?g|gif|webp|avif|ico|pdf|mp4|webm|mov|mp3|m4a|wav|ogg|log|ini|conf|env\.example)$/i;

/**
 * 返答の Markdown のインラインコードが、ファイルのパスに見えるか。
 * 拡張子付きで、空白や URL・ワイルドカードを含まないものだけを対象にする（`slides/index.html` など）。
 * 実際にあるかどうかは、開くときに Hub が確かめる。
 */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 260 || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (/[*?<>|"`$]/.test(t)) return false;
  // 行番号付き（src/a.ts:12）は行番号を外して判定する
  return EXT.test(t.replace(/:\d+(:\d+)?$/, ''));
}

/** インラインコードからパスだけを取り出す（行番号を外す） */
export function stripLineNo(text: string): string {
  return text.trim().replace(/:\d+(:\d+)?$/, '');
}

/**
 * 返答の Markdown のリンク先（[名前](G:\a\b.html) や [名前](src/a.ts#L12) など）が手元のファイルなら、そのパスを返す。
 * http(s) や mailto などの URL と、ページ内の # だけのリンクは null（ふつうのリンクとして扱う）。
 */
export function linkToFilePath(href: string | undefined): string | null {
  let t = (href ?? '').trim();
  if (!t || t.startsWith('#')) return null;
  // file:///G:/a/b.html → G:/a/b.html、file:///home/a → /home/a
  if (/^file:/i.test(t)) t = t.replace(/^file:\/*/i, '/').replace(/^\/([a-z]:)/i, '$1');
  // ドライブ文字（G:\ や G:/。Markdown の変換で \ は %5C になる）以外のスキームは URL
  else if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:([\\/]|%5c)/i.test(t)) return null;
  // 行番号（#L12、#L12-L20、:12）を外す
  t = t.replace(/#L\d+(-L?\d+)?$/i, '');
  if (t.includes('%')) {
    try {
      t = decodeURIComponent(t);
    } catch {
      // そのまま使う
    }
  }
  t = stripLineNo(t);
  return t || null;
}
