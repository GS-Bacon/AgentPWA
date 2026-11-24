// 巻き戻しとフォーク（プロトコル v11）のための、resume_token の形と会話の記録（jsonl）の読み取り。
//
// claude CLI は `--resume <id> --resume-session-at <記録の uuid> --fork-session` で、会話を途中までにした
// 新しいセッションを始められる（Claude Code 2.1.327 で確認。--resume-session-at はヘルプに出ない）。
// ただし新しい session_id は、最初の指示を送って起動するまで分からない。そこで、まだ起動していない
// 「途中から始める予定」を resume_token に入れておき（Hub はこれを中身を見ずに保存する）、起動して
// system/init で新しい session_id が届いたら、それを resume_token として送り直す。
//
// ユーザーの発言の messageId には、送るときに付けた uuid（CLI の記録の uuid と同じ）を使う。
import type { ProcessLauncher } from './launcher.ts';
import { pathFor } from './launcher.ts';

/** resume_token の中身 */
export interface ResumeRef {
  /** 再開する CLI の session_id。空なら新しく始める（最初の発言まで巻き戻したとき） */
  sessionId: string;
  /** この記録の uuid までで会話を切って始める（--resume-session-at） */
  at?: string;
  /** 新しい session_id で始める（--fork-session） */
  fork?: boolean;
}

/** session_id と記録の uuid として受け付ける形（パスと CLI の引数に使うので、区切り文字などは通さない） */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** 最初の発言まで巻き戻して、会話が残っていない状態 */
const FRESH = 'fresh';

/**
 * resume_token を読む。形は `<session_id>` か `<session_id>|at=<uuid>|fork`（途中から始める予定）か `fresh`。
 * 形が正しくなければ null。
 */
export function parseResumeToken(token: string | undefined): ResumeRef | null {
  if (!token) return null;
  if (token === FRESH) return { sessionId: '' };
  const [sessionId, ...rest] = token.split('|');
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const ref: ResumeRef = { sessionId };
  for (const part of rest) {
    if (part === 'fork') ref.fork = true;
    else if (part.startsWith('at=') && SESSION_ID_RE.test(part.slice(3))) ref.at = part.slice(3);
    else return null;
  }
  return ref;
}

export function formatResumeToken(ref: ResumeRef): string {
  if (!ref.sessionId) return FRESH;
  let s = ref.sessionId;
  if (ref.at) s += `|at=${ref.at}`;
  if (ref.fork) s += '|fork';
  return s;
}

/** これから起動するときの claude CLI の引数（--resume など） */
export function resumeArgs(ref: ResumeRef | null): string[] {
  if (!ref?.sessionId) return [];
  const args = ['--resume', ref.sessionId];
  if (ref.at) args.push('--resume-session-at', ref.at);
  if (ref.fork) args.push('--fork-session');
  return args;
}

/**
 * claude CLI がセッションの履歴を置くフォルダ名。作業フォルダの英数字以外を `-` に置き換えたもの
 * （例: `C:\Users\me\work` → `C--Users-me-work`）。Claude Code 2.1.327 で確認。
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** 会話の記録（<session_id>.jsonl）のパス */
export async function transcriptPath(launcher: ProcessLauncher, configDir: string | undefined, cwd: string, sessionId: string): Promise<string> {
  const p = pathFor(launcher.os);
  const dir = configDir || p.join(await launcher.homeDir(), '.claude');
  return p.join(dir, 'projects', projectDirName(cwd), `${sessionId}.jsonl`);
}

/** 記録の1行（必要な項目だけ） */
interface Entry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}

export function parseTranscript(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e && typeof e.uuid === 'string') out.push(e);
    } catch {
      /* 書きかけの行などは飛ばす */
    }
  }
  return out;
}

/** ユーザーが入力した発言か（ツールの結果・CLI が足した文・サブエージェントの発言を除く） */
function isPrompt(e: Entry): boolean {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => (b as { type?: string })?.type === 'tool_result');
}

/**
 * 巻き戻しの位置: 発言 messageId の直前の記録の uuid。発言が会話の最初なら null（会話が残らない）。
 * 発言が記録に無ければ例外。
 */
export function rewindPoint(entries: Entry[], messageId: string): string | null {
  const e = entries.find((x) => x.uuid === messageId);
  if (!e || !isPrompt(e)) throw new Error('この発言は claude CLI の記録に見つかりません');
  return e.parentUuid ?? null;
}

/**
 * フォークの位置: 発言 messageId のターンの終わり（次のユーザーの発言の直前）の記録の uuid。
 * 次の発言が無ければ undefined（会話の終わりまで引き継ぐ）。発言が記録に無ければ例外。
 */
export function forkPoint(entries: Entry[], messageId: string): string | undefined {
  const start = entries.findIndex((x) => x.uuid === messageId);
  if (start < 0 || !isPrompt(entries[start])) throw new Error('この発言は claude CLI の記録に見つかりません');
  // 発言から続く記録（子孫）を、記録の順にたどる
  const chain = new Set<string>([messageId]);
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (!e.parentUuid || !chain.has(e.parentUuid)) continue;
    if (isPrompt(e)) return e.parentUuid;
    chain.add(e.uuid as string);
  }
  return undefined;
}
