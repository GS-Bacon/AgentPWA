// Hub なしで Claude Driver を試す簡易ツール。
//
//   npm run try -w @agentpwa/driver-claude -- --cwd <フォルダ> [--model haiku] [--mode ask|auto_edit|auto|full_auto|plan] [--resume <id>] [最初の指示]
//
// 標準入力から UserAction を 1 行 1 件の JSON で受け取り、DriverEvent を 1 行 1 件の JSON（JSONL）で標準出力に出す。
// 例: {"type":"send","text":"こんにちは"} / {"type":"approve","requestId":"toolu_...","decision":"allow"} / {"type":"interrupt"}
//     {"type":"set_permission_mode","mode":"auto_edit"}
// 標準入力を閉じるとセッションを停止して終了する。
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { PermissionMode, UserAction } from '@agentpwa/shared';
import { createClaudeDriver } from '../src/index.ts';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const cwd = opt('cwd') ?? process.cwd();
const model = opt('model');
const mode = (opt('mode') ?? 'ask') as PermissionMode;
const resumeToken = opt('resume');
const prompt = argv.join(' ') || undefined;

const driver = createClaudeDriver();
const auth = await driver.checkAuth();
process.stderr.write(`auth: ${JSON.stringify(auth)}\n`);
if (!auth.ok) process.exit(1);

const session = await driver.start(
  { sessionId: randomUUID(), cwd, model, permissionMode: mode, initialPrompt: prompt, resumeToken },
  (e) => process.stdout.write(JSON.stringify(e) + '\n'),
);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    await session.send(JSON.parse(line) as UserAction);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
  }
});
rl.on('close', async () => {
  await session.stop();
  process.exit(0);
});
