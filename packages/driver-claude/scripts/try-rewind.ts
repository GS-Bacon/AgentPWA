// 巻き戻しとフォーク（v11）を本物の claude CLI で確かめる（haiku で数回だけ呼ぶ）。
// 使い方: npx tsx scripts/try-rewind.ts <空の作業フォルダ>
import fs from 'node:fs';
import path from 'node:path';
import type { DriverEvent, DriverSession } from '@agentpwa/shared';
import { createClaudeDriver } from '../src/index.ts';

const cwd = path.resolve(process.argv[2] ?? '.');
const driver = createClaudeDriver({ resolveDefaults: false });

function open(sessionId: string, resumeToken?: string) {
  const events: DriverEvent[] = [];
  let waiters: (() => void)[] = [];
  const emit = (e: DriverEvent) => {
    events.push(e);
    if (e.type === 'message' && e.role === 'assistant') console.log(`  [${sessionId}] assistant: ${e.text.replace(/\n/g, ' ').slice(0, 200)}`);
    if (e.type === 'error') console.log(`  [${sessionId}] error: ${e.message}`);
    if (e.type === 'status' && e.status === 'idle') {
      const w = waiters;
      waiters = [];
      w.forEach((f) => f());
    }
  };
  const idle = () => new Promise<void>((r) => waiters.push(r));
  return { events, idle, start: () => driver.start({ sessionId, cwd, permissionMode: 'auto_edit', model: 'haiku', resumeToken }, emit) };
}

async function turn(s: DriverSession, idle: () => Promise<void>, text: string) {
  const done = idle();
  await s.send({ type: 'send', text });
  await done;
}

const a = open('A');
const sa = await a.start();
await turn(sa, a.idle, 'Use the Write tool to create a.txt containing exactly: one');
await turn(sa, a.idle, 'Use the Write tool to overwrite a.txt with exactly: two');
const users = a.events.filter((e): e is Extract<DriverEvent, { type: 'message' }> => e.type === 'message' && e.role === 'user');
const token = a.events.filter((e) => e.type === 'resume_token').at(-1);
console.log('a.txt =', fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8').trim(), ' token =', token);

// フォーク（1つ目のターンの終わりから）
const forkToken = await driver.forkToken!({ cwd, resumeToken: (token as { token: string }).token, messageId: users[0].messageId });
console.log('fork token =', forkToken);

// 巻き戻し（2つ目の発言の直前まで、会話とコード）
await sa.send({ type: 'rewind', messageId: users[1].messageId, restore: 'both' });
console.log('after rewind: a.txt =', fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8').trim(), ' events =', JSON.stringify(a.events.slice(-2)));
await turn(sa, a.idle, 'List every instruction I have given you in this conversation, verbatim. Nothing else.');
await sa.stop();

const f = open('F', forkToken);
const sf = await f.start();
await turn(sf, f.idle, 'List every instruction I have given you in this conversation, verbatim. Nothing else.');
console.log('fork resume_token =', JSON.stringify(f.events.filter((e) => e.type === 'resume_token')));
await sf.stop();
