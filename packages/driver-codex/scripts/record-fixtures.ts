// 手動の実 CLI テスト。ChatGPT ログインと残り枠を検査してから、短い3セッションを記録する。
// 既存フィクスチャは上書きせず .local/recordings に保存する。API キーは受け付けない。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriverEvent, DriverSession, PermissionMode } from '@agentpwa/shared';
import { createCodexDriver } from '../src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.local', 'recordings');
const cwd = path.join(root, '.local', 'scenarios', String(Date.now()));
await mkdir(output, { recursive: true });
await mkdir(cwd, { recursive: true });
const driver = createCodexDriver();
const auth = await driver.checkAuth();
if (!auth.ok) throw new Error(auth.detail);
process.stderr.write(`認証確認: ${auth.auth} / ${auth.version}\n`);

async function record(name: string, mode: PermissionMode, prompt: string) {
  const events: DriverEvent[] = [];
  let session: DriverSession | undefined;
  let interrupted = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const actions: (() => Promise<void>)[] = [];
  const schedule = (action: () => Promise<void>) => {
    if (session) void action().catch((e) => { process.stderr.write(String(e) + '\n'); finish(); });
    else actions.push(action);
  };
  const timeout = setTimeout(finish, 90_000);
  try {
    session = await driver.start({ sessionId: `record-${name}`, cwd, permissionMode: mode,
      model: process.argv[2] ?? 'gpt-6.2-sol', effort: 'low',
    }, (event) => {
      events.push(event);
      if (event.type === 'error') process.stderr.write(`${name}: ${event.message}\n`);
      if (event.type === 'approval_request') {
        process.stderr.write(`${name}: 承認要求を受信\n`);
        // 記録用フォルダの sample.txt だけを許可する。一般のコマンドは自動承認しない。
        const allowed = (event.kind === 'file_change' && event.changes?.length === 1 &&
          path.resolve(cwd, event.changes[0].path) === path.join(cwd, 'sample.txt') && event.changes[0].kind === 'add') ||
          (event.kind === 'command' && event.cwd === cwd && /-Command 'Get-Content -LiteralPath sample\.txt -Encoding UTF8'$/i.test(event.command ?? ''));
        schedule(() => session!.send({ type: 'approve', requestId: event.requestId, decision: allowed ? 'allow' : 'deny' }));
      }
      if (event.type === 'question') {
        process.stderr.write(`${name}: 質問を受信\n`);
        schedule(() => session!.send({ type: 'answer', requestId: event.requestId, text: '青', answers: (event.questions ?? [{}]).map(() => '青') }));
      }
      if (name === 'interrupt' && event.type === 'status' && event.status === 'running' && !interrupted) {
        interrupted = true;
        schedule(() => session!.send({ type: 'interrupt' }));
      }
      if (event.type === 'status' && event.status === 'idle' && events.some((e) => e.type === 'status' && e.status === 'running')) finish();
      if (event.type === 'error' && event.fatal) finish();
    });
    for (const action of actions) await action();
    await session.send({ type: 'send', text: prompt });
    await finished;
  } finally {
    clearTimeout(timeout);
    await session?.stop();
    await writeFile(path.join(output, `${name}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const expected = name === 'approval' ? events.some((e) => e.type === 'approval_resolved' && e.decision === 'allow') : name === 'question' ? events.some((e) => e.type === 'question_resolved') : events.some((e) => e.type === 'status' && e.reason === '中断しました');
  if (!expected) throw new Error(`${name} の記録を確認できませんでした（.local の記録を確認してください）`);
  process.stderr.write(`${name}: 記録完了（${events.length} イベント）\n`);
}

const only = process.argv[3];
if (only && !['approval', 'question', 'interrupt'].includes(only)) throw new Error('記録するシナリオが不正です');
if (!only || only === 'approval') await record('approval', 'ask', '承認フローの検証です。この作業フォルダに sample.txt を apply_patch で新規作成し、内容は「テスト」の一行だけにしてください。追加調査や別の変更はせず、完了後「完了」とだけ返してください。');
if (!only || only === 'question') await record('question', 'plan', '質問フローの検証です。request_user_input を一度だけ呼び、「色を選んでください」という質問を「青」「赤」の選択肢で出してください。回答を受け取ったら「確認しました」とだけ返してください。ファイル操作と追加調査は不要です。');
if (!only || only === 'interrupt') await record('interrupt', 'ask', '中断フローの検証です。1から100までの数字を順に数える短い説明を考えてください。ファイル操作は不要です。');
