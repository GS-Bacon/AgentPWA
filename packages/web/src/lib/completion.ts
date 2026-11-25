// 入力欄の補完（/ でコマンド、@ でファイル、# でプロジェクトの候補）。
// Claude のアプリに合わせ、/ は入力の先頭だけ、@ と # は行のどこでも（空白の直後なら）出す。
// 日本語入力では記号が全角（／＠＃）になりやすいので、全角でも同じに扱い、選んだら半角に直す。
import { useEffect, useState } from 'react';
import type { MentionItem, ProjectTag } from '@agentpwa/hub/api';
import { api } from './api.ts';

export type TriggerKind = 'command' | 'file' | 'tag';

export interface Trigger {
  kind: TriggerKind;
  /** 記号の後ろからカーソルまでの文字（全角の英数字は半角に直したもの） */
  query: string;
  /** 置き換える範囲（記号の位置から、カーソルの後ろに続く名前の続き（英数字など）の終わりまで） */
  start: number;
  end: number;
}

const MARK: Record<string, TriggerKind> = { '/': 'command', '／': 'command', '@': 'file', '＠': 'file', '#': 'tag', '＃': 'tag' };
export const TRIGGER_CHAR: Record<TriggerKind, string> = { command: '/', file: '@', tag: '#' };

/** 全角の英数字・記号を半角にそろえる（ＪＯ１ → JO1） */
export function toHalfWidth(s: string): string {
  return s.normalize('NFKC');
}

/** カーソルの位置で補完を出すなら、その種類と範囲。出さないなら null */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  // 空白でない文字が続く範囲（カーソルの前後）
  const m = /\S*$/.exec(before);
  const tokenStart = m ? caret - m[0].length : caret;
  // カーソルの後ろは、名前やパスの続きに見える文字（英数字と . _ - / \）だけを置き換える範囲に入れる
  // （「＃J0|を見て」で選んだときに「を見て」を消さないように）
  const after = /^[A-Za-z0-9_.\-/\\Ａ-Ｚａ-ｚ０-９]*/.exec(text.slice(caret))?.[0] ?? '';
  const token = before.slice(tokenStart);
  if (!token) return null;
  // コマンドは入力の先頭だけ（名前に / は入らない）
  if (tokenStart === 0 && MARK[token[0]] === 'command') {
    const q = token.slice(1);
    return /[/／]/.test(q) ? null : { kind: 'command', query: toHalfWidth(q), start: 0, end: caret + after.length };
  }
  // @ と # は、空白の後でなくても出す（日本語の文では「案件＃J01」のように続けて書くので）。
  // ただし英数字の直後（a@b.com や a#b）は除く
  let i = token.length - 1;
  while (i >= 0 && MARK[token[i]] !== 'file' && MARK[token[i]] !== 'tag') i--;
  if (i < 0) return null;
  if (i > 0 && /[A-Za-z0-9_.\-]/.test(token[i - 1])) return null;
  const kind = MARK[token[i]];
  return { kind, query: toHalfWidth(token.slice(i + 1)), start: tokenStart + i, end: caret + after.length };
}

/** 補完した後の文字とカーソルの位置。続けて打てるよう、後ろに空白を足す（フォルダは足さずに中を続けて出す） */
export function applyCompletion(text: string, t: Trigger, value: string, keepOpen = false): { text: string; caret: number } {
  const rest = text.slice(t.end);
  const insert = `${TRIGGER_CHAR[t.kind]}${value}${keepOpen || /^\s/.test(rest) ? '' : ' '}`;
  const head = text.slice(0, t.start) + insert;
  return { text: head + rest, caret: keepOpen || !/^\s/.test(rest) ? head.length : head.length + 1 };
}

/** # の候補を絞り込む。名前の前方一致を先に、そのあと名前・説明の部分一致 */
export function filterTags(tags: ProjectTag[], query: string, limit = 50): ProjectTag[] {
  const q = query.toLowerCase();
  if (!q) return tags.slice(0, limit);
  const head: ProjectTag[] = [];
  const rest: ProjectTag[] = [];
  for (const t of tags) {
    const n = toHalfWidth(t.name).toLowerCase();
    if (n.startsWith(q)) head.push(t);
    else if (n.includes(q) || toHalfWidth(t.description ?? '').toLowerCase().includes(q)) rest.push(t);
  }
  return [...head, ...rest].slice(0, limit);
}

/** @ の候補の取得（打つたびに聞くので、少し待ってからまとめて聞く。同じ問い合わせはしばらく覚えておく） */
const mentionCache = new Map<string, { list: MentionItem[]; at: number }>();
const MENTION_TTL_MS = 20_000;

export function useMentions(sessionId: string, query: string | null): { list: MentionItem[]; loading: boolean; error?: string } {
  const key = query === null ? null : `${sessionId}\n${query}`;
  const cached = key ? mentionCache.get(key) : undefined;
  const fresh = cached && Date.now() - cached.at < MENTION_TTL_MS ? cached.list : undefined;
  const [state, setState] = useState<{ key: string | null; list: MentionItem[]; error?: string }>({ key: null, list: [] });
  useEffect(() => {
    if (key === null || query === null || fresh) return;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .mentions(sessionId, query)
        .then((list) => {
          mentionCache.set(key, { list, at: Date.now() });
          if (alive) setState({ key, list });
        })
        .catch((e: Error) => {
          if (alive) setState((s) => ({ key, list: s.list, error: e.message }));
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]);
  if (key === null) return { list: [], loading: false };
  if (fresh) return { list: fresh, loading: false };
  // 届くまでは前の結果を出しておく（打つたびに一覧が消えないように）
  return { list: state.list, loading: state.key !== key && !state.error, error: state.key === key ? state.error : undefined };
}
