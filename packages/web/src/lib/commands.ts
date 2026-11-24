// 入力欄のスラッシュコマンドの補完。一覧はセッションごとに Hub に聞いて覚えておく。
import { useEffect, useState } from 'react';
import type { SlashCommand } from '@agentpwa/shared';
import { api } from './api.ts';

type Entry = { list?: SlashCommand[]; error?: string; promise?: Promise<void>; at: number };

/** 覚えておく時間（Hub 側でも作業フォルダごとに覚えている） */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function load(sessionId: string): void {
  const e = cache.get(sessionId);
  if (e?.promise || (e?.list && Date.now() - e.at < TTL_MS)) return;
  const entry: Entry = { list: e?.list, at: e?.at ?? 0 };
  entry.promise = api
    .commands(sessionId)
    .then((list) => {
      entry.list = list;
      entry.error = undefined;
      entry.at = Date.now();
    })
    .catch((err: Error) => {
      entry.error = err.message;
      // 失敗したら、しばらくしてからもう一度聞けるようにする
      entry.at = 0;
    })
    .finally(() => {
      entry.promise = undefined;
      for (const l of listeners) l();
    });
  cache.set(sessionId, entry);
}

/** enabled になったら一覧を取りに行く。取れるまでは loading */
export function useCommands(sessionId: string, enabled: boolean): { list: SlashCommand[]; loading: boolean; error?: string } {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (enabled) load(sessionId);
  }, [sessionId, enabled]);
  const e = cache.get(sessionId);
  return { list: e?.list ?? [], loading: !!e?.promise && !e.list, error: e?.list ? undefined : e?.error };
}

/** 入力中の「/名前」の部分（先頭が / で、まだ空白を打っていないとき）。それ以外は null */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1] : null;
}

/** 名前の前方一致を先に、そのあと名前・説明の部分一致を並べる */
export function filterCommands(list: SlashCommand[], query: string, limit = 50): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return list.slice(0, limit);
  const head: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const c of list) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) head.push(c);
    else if (n.includes(q) || c.description?.toLowerCase().includes(q)) rest.push(c);
  }
  return [...head, ...rest].slice(0, limit);
}
