// Hub なしで操作する手動ツール。stdout は DriverEvent のみを記録する。
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { EffortLevel, PermissionMode, UserAction } from '@agentpwa/shared';
import { createCodexDriver } from '../src/index.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  cwd: { type: 'string', default: process.cwd() },
  'codex-path': { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
  mode: { type: 'string', default: 'ask' }, resume: { type: 'string' },
} });
if (!['ask', 'auto_edit', 'auto', 'full_auto', 'plan'].includes(values.mode!)) throw new Error('権限モードが不正です');
if (values.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)) throw new Error('エフォートが不正です');
const driver = createCodexDriver({ codexPath: values['codex-path'] });
const auth = await driver.checkAuth();
process.stderr.write(JSON.stringify(auth) + '\n');
if (!auth.ok) process.exit(1);

// 起動中に届いた stdin も取りこぼさないよう先に読む。
const rl = createInterface({ input: process.stdin });
const actions: UserAction[] = [];
let ended = false;
let session: Awaited<ReturnType<typeof driver.start>> | undefined;
let queue = Promise.resolve();
const send = (action: UserAction) => {
  queue = queue.then(() => session!.send(action)).catch((error) => {
    process.stderr.write(`操作失敗: ${(error as Error).message}\n`);
  });
};
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const action = JSON.parse(line) as UserAction;
    if (session) send(action); else actions.push(action);
  } catch { process.stderr.write('UserAction の JSON が不正です\n'); }
});
rl.on('close', () => { ended = true; if (session) void queue.then(() => session!.stop()); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (session) void session.stop().then(() => process.exit(0)); else process.exit(0);
});
try {
  session = await driver.start({
    sessionId: randomUUID(), cwd: values.cwd!, permissionMode: values.mode as PermissionMode,
    model: values.model, effort: values.effort as EffortLevel | undefined, resumeToken: values.resume,
    initialPrompt: positionals.join(' ') || undefined,
  }, (event) => process.stdout.write(JSON.stringify(event) + '\n'));
  for (const action of actions) send(action);
  if (ended) await queue.then(() => session!.stop());
} catch (error) {
  rl.close();
  process.stderr.write(`起動失敗: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
