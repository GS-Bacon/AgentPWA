import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DriverEvent, DriverSession } from '@agentpwa/shared';
import { createDriver } from '../src/index.ts';
import { FakeServer } from './fake-server.ts';
import { RpcClient } from '../src/rpc.ts';

const sessions: DriverSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((s) => s.stop())); vi.unstubAllEnvs(); });
function setup() {
  const server = new FakeServer();
  const driver = createDriver({ launch: server.launch, version: async () => 'codex-cli 0.171.0-alpha.13' });
  const events: DriverEvent[] = [];
  const start = async (overrides = {}) => {
    const session = await driver.start({ sessionId: 'hub-test', cwd: process.cwd(), permissionMode: 'ask', ...overrides }, (event) => events.push(event));
    sessions.push(session);
    return session;
  };
  return { server, driver, events, start };
}

describe('課金経路の拒否', () => {
  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENAI_BASE_URL', 'openai_api_key'])('%s があれば CLI を起動しない', async (key) => {
    vi.stubEnv(key, '秘密の値');
    const launch = vi.fn();
    const driver = createDriver({ launch, version: async () => 'test' });
    const auth = await driver.checkAuth();
    expect(auth).toMatchObject({ ok: false, auth: 'api_key' });
    expect(JSON.stringify(auth)).not.toContain('秘密の値');
    await expect(driver.start({ sessionId: 's', cwd: '.', permissionMode: 'ask' }, () => {})).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(['apiKey', 'amazonBedrock', 'gcp', 'unknown'])('アカウント %s では開始しない', async (type) => {
    const { server, start } = setup(); server.account = { type };
    await expect(start({ initialPrompt: '送らない' })).rejects.toThrow();
    expect(server.messages.some((m) => /thread\/start|turn\/start/.test(m.method))).toBe(false);
  });
  it('未ログインを none として返し接続を閉じる', async () => {
    const { server, driver } = setup(); server.account = null;
    expect(await driver.checkAuth()).toMatchObject({ ok: false, auth: 'none' });
    expect(server.child.exitCode).toBe(0);
  });
  it.each([{ model_provider: 'custom' }, { model_providers: { openai: { env_key: 'OTHER_API_KEY' } } }, { forced_login_method: 'api' }])('独自接続設定を拒否する', async (config) => {
    const { server, driver } = setup(); server.config = config;
    expect(await driver.checkAuth()).toMatchObject({ ok: false, auth: 'api_key' });
  });
  it('ChatGPT ログインを返す', async () => {
    const { driver, server } = setup();
    expect(await driver.checkAuth()).toMatchObject({ ok: true, auth: 'subscription' });
    expect(server.messages.some((m) => m.method === 'turn/start')).toBe(false);
  });
  it.each([100, 101, NaN])('利用枠 %s なら送信しない', async (usedPercent) => {
    const { start, server } = setup(); const session = await start();
    server.quota = { rateLimits: { primary: { usedPercent } } };
    await expect(session.send({ type: 'send', text: '送らない' })).rejects.toThrow('追加クレジット');
    expect(server.messages.some((m) => m.method === 'turn/start')).toBe(false);
  });
  it('利用枠を確認できないと送信しない', async () => {
    const { start, server } = setup(); const session = await start(); server.quota = {};
    await expect(session.send({ type: 'send', text: '送らない' })).rejects.toThrow();
  });
  it.each([false, null, undefined])('ordinaryUsageAllowed が %s の場合は残り枠があっても拒否する', async (allowed) => {
    const { start, server } = setup(); const session = await start(); server.quota.ordinaryUsageAllowed = allowed;
    await expect(session.send({ type: 'send', text: '送らない' })).rejects.toThrow('追加クレジット');
    expect(server.messages.some((m) => m.method === 'turn/start')).toBe(false);
  });
  it.each([{ hasCredits: true }, { hasCredits: false, unlimited: true }, null])('追加クレジットや不明な残高 %j を拒否する', async (credits) => {
    const { start, server } = setup(); const session = await start(); server.quota.rateLimits.credits = credits;
    await expect(session.send({ type: 'send', text: '送らない' })).rejects.toThrow();
    expect(server.messages.some((m) => m.method === 'turn/start')).toBe(false);
  });
  it('開始後の認証の変更も毎回検査する', async () => {
    const { start, server, events } = setup(); const session = await start(); server.account = { type: 'apiKey' };
    await expect(session.send({ type: 'send', text: '送らない' })).rejects.toThrow();
    server.notify('account/updated', { authMode: 'apikey' });
    await session.stop();
    expect(events.at(-1)).toEqual({ type: 'status', status: 'stopped' });
  });
});

describe('セッションと状態遷移', () => {
  it('初期化、開始、再開トークン、追加指示、中断、再送信', async () => {
    const { start, server, events } = setup(); const session = await start({ initialPrompt: '最初の指示', resumeToken: 'saved-thread' });
    expect(server.messages.slice(0, 2).map((m) => m.method)).toEqual(['initialize', 'initialized']);
    expect(events).toContainEqual({ type: 'resume_token', token: 'saved-thread' });
    await session.send({ type: 'send', text: '追加指示' });
    expect(server.messages.find((m) => m.method === 'turn/steer')?.params).toMatchObject({ threadId: 'saved-thread', expectedTurnId: 'turn-1' });
    await session.send({ type: 'interrupt' });
    expect(server.messages.find((m) => m.method === 'turn/interrupt')?.params.turnId).toBe('turn-1');
    server.notify('turn/completed', { threadId: 'saved-thread', turn: { id: 'turn-1', status: 'interrupted' } });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
    await session.send({ type: 'send', text: '次の指示' });
    expect(server.messages.filter((m) => m.method === 'turn/start')).toHaveLength(2);
  });
  it('並行送信でも turn/start を重複させない', async () => {
    const { start, server } = setup(); const session = await start();
    await Promise.all([session.send({ type: 'send', text: 'a' }), session.send({ type: 'send', text: 'b' })]);
    expect(server.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(server.messages.filter((m) => m.method === 'turn/steer')).toHaveLength(1);
  });
  it('開始応答と started 通知の間に中断を送らない', async () => {
    const { start, server } = setup(); const session = await start();
    const originalNotify = server.notify.bind(server);
    server.notify = (method, params) => {
      if (method === 'turn/started') setTimeout(() => originalNotify(method, params), 20);
      else originalNotify(method, params);
    };
    const send = session.send({ type: 'send', text: '開始' });
    const interrupt = session.send({ type: 'interrupt' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(server.messages.some((m) => m.method === 'turn/interrupt')).toBe(false);
    await send; await interrupt;
    expect(server.messages.find((m) => m.method === 'turn/interrupt')?.params.turnId).toBe('turn-1');
  });
  it('応答より完了が先でも running に戻らない', async () => {
    const { start, server, events } = setup(); const session = await start();
    server.handler = (m) => {
      if (m.method !== 'turn/start') return;
      server.notify('turn/completed', { turn: { id: 'fast', status: 'completed' } });
      return { turn: { id: 'fast' } };
    };
    await session.send({ type: 'send', text: '一瞬で完了' });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });
  it('断片の後に同じ ID の確定メッセージを送る', async () => {
    const { start, server, events } = setup(); await start();
    server.notify('item/agentMessage/delta', { itemId: 'a', delta: '返答' });
    server.notify('item/completed', { item: { type: 'agentMessage', id: 'a', text: '返答です' } });
    expect(events.slice(-2)).toEqual([{ type: 'message_delta', messageId: 'a', text: '返答' }, { type: 'message', messageId: 'a', role: 'assistant', text: '返答です' }]);
  });
  it('予期しないプロセス終了で error と stopped を送る', async () => {
    const { start, server, events } = setup(); const session = await start(); server.close();
    await new Promise((resolve) => setImmediate(resolve)); await session.stop();
    expect(events).toContainEqual({ type: 'status', status: 'error' });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'stopped' });
    await expect(session.send({ type: 'send', text: '再利用しない' })).rejects.toThrow();
  });
  it('利用枠通知で長さを伝え、枠切れでは停止する', async () => {
    const { start, server, events } = setup(); const session = await start();
    server.notify('account/rateLimits/updated', server.quota);
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', windowMinutes: 300 }));
    server.notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100 } } });
    await session.stop(); expect(events.at(-1)).toMatchObject({ status: 'stopped' });
  });
});

describe('承認と質問', () => {
  it('複数承認をすべて解決するまで待機し、RPC の ID を区別する', async () => {
    const { start, server, events } = setup(); const session = await start({ initialPrompt: '開始' });
    for (const id of [1, '1']) server.request(id, 'item/commandExecution/requestApproval', { threadId: 'thread-test', itemId: 'cmd', command: 'npm test', availableDecisions: ['accept', 'decline'] });
    const requests = events.filter((e) => e.type === 'approval_request');
    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    await expect(session.send({ type: 'approve', requestId: requests[0].requestId, decision: 'allow_session' })).rejects.toThrow();
    await session.send({ type: 'approve', requestId: requests[0].requestId, decision: 'allow' });
    expect(events.at(-1)).toMatchObject({ status: 'waiting_approval' });
    await session.send({ type: 'approve', requestId: requests[1].requestId, decision: 'deny' });
    expect(events.at(-1)).toMatchObject({ status: 'running' });
    expect(server.messages.filter((m) => m.result?.decision).map((m) => [m.id, m.result.decision])).toEqual([[1, 'accept'], ['1', 'decline']]);
  });
  it('item/started の差分から変更行数と paths を伝える', async () => {
    const { start, server, events } = setup(); await start();
    server.notify('item/started', { item: { id: 'patch', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n' }] } });
    server.request(8, 'item/fileChange/requestApproval', { itemId: 'patch' });
    expect(events.find((e) => e.type === 'approval_request')).toMatchObject({ changes: [{ path: 'src/a.ts', kind: 'modify', additions: 2, deletions: 1 }] });
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ paths: ['src/a.ts'] });
  });
  it.each(['add', 'delete'])('%s の生の本文から unified diff と行数を作る', async (kind) => {
    const { start, server, events } = setup(); await start();
    server.notify('item/started', { item: { id: 'patch', type: 'fileChange', changes: [{ path: 'sample.txt', kind: { type: kind }, diff: '一行目\n二行目\n' }] } });
    server.request(8, 'item/fileChange/requestApproval', { itemId: 'patch' });
    const request = events.find((e) => e.type === 'approval_request');
    expect(request?.changes?.[0]).toMatchObject({ kind, additions: kind === 'add' ? 2 : 0, deletions: kind === 'delete' ? 2 : 0 });
    expect(request?.changes?.[0].diff).toContain(kind === 'add' ? '+一行目' : '-一行目');
  });
  it('diff ヘッダーに似た本文も追加行として数える', async () => {
    const { start, server, events } = setup(); await start();
    server.notify('item/started', { item: { id: 'patch', type: 'fileChange', changes: [{ path: 'sample.txt', kind: { type: 'add' }, diff: '--- ヘッダーに似た本文\n+++ 追加行に似た本文\n' }] } });
    server.request(8, 'item/fileChange/requestApproval', { itemId: 'patch' });
    expect(events.find((e) => e.type === 'approval_request')?.changes?.[0]).toMatchObject({ additions: 2, deletions: 0 });
  });
  it('decline の代わりに cancel で拒否する', async () => {
    const { start, server, events } = setup(); const session = await start({ initialPrompt: '開始' });
    server.request(91, 'item/commandExecution/requestApproval', { command: 'test', availableDecisions: ['accept', 'cancel'] });
    const request = events.find((e) => e.type === 'approval_request')!;
    await session.send({ type: 'approve', requestId: request.requestId, decision: 'deny' });
    expect(server.messages.find((m) => m.id === 91)?.result).toEqual({ decision: 'cancel' });
  });
  it('追加権限は要求された範囲と指定の寿命だけを返す', async () => {
    const { start, server, events } = setup(); const session = await start({ initialPrompt: '開始' });
    const permissions = { network: { enabled: true } };
    server.request(92, 'item/permissions/requestApproval', { permissions });
    const request = events.find((e) => e.type === 'approval_request')!;
    await session.send({ type: 'approve', requestId: request.requestId, decision: 'allow_session' });
    expect(server.messages.find((m) => m.id === 92)?.result).toEqual({ permissions, scope: 'session' });
  });
  it('複数質問を ID ごとの回答へ変換する', async () => {
    const { start, server, events } = setup(); const session = await start({ initialPrompt: '開始' });
    server.request('q', 'item/tool/requestUserInput', { questions: [{ id: 'a', header: '形式', question: '形式は？', options: [{ label: 'JSON', description: '機械向け' }] }, { id: 'b', header: '色', question: '色は？', options: null }] });
    expect(events.at(-1)).toMatchObject({ status: 'waiting_input' });
    const request = events.find((e) => e.type === 'question');
    expect(request).toMatchObject({ questions: [{ options: [{ label: 'JSON', description: '機械向け' }] }, { options: [] }] });
    await expect(session.send({ type: 'answer', requestId: request!.requestId, text: '不完全' })).rejects.toThrow();
    await session.send({ type: 'answer', requestId: request!.requestId, text: '全文', answers: ['JSON', '青'] });
    expect(server.messages.find((m) => m.id === 'q')?.result).toEqual({ answers: { a: { answers: ['JSON'] }, b: { answers: ['青'] } } });
    expect(events.at(-1)).toMatchObject({ status: 'running' });
  });
  it('外部解決、中断の質問を残さない', async () => {
    const { start, server, events } = setup(); await start({ initialPrompt: '開始' });
    server.request(70, 'item/tool/requestUserInput', { questions: [{ id: 'q', question: '選ぶ？' }] });
    server.notify('serverRequest/resolved', { requestId: 70 });
    expect(events.slice(-2)).toEqual([{ type: 'question_resolved', requestId: 'rpc:number:70' }, { type: 'status', status: 'running' }]);
  });
  it('認証の再検査中に解決された質問へ古い回答を返さない', async () => {
    const { start, server, events } = setup(); const session = await start({ initialPrompt: '開始' });
    server.request(71, 'item/tool/requestUserInput', { questions: [{ id: 'q', question: '選ぶ？' }] });
    const request = events.find((e) => e.type === 'question')!;
    server.handler = (m) => {
      if (m.method === 'account/rateLimits/read') server.notify('serverRequest/resolved', { requestId: 71 });
      return undefined;
    };
    await expect(session.send({ type: 'answer', requestId: request.requestId, text: '青' })).rejects.toThrow('解決しています');
    expect(server.messages.some((m) => m.id === 71)).toBe(false);
  });
  it('秘密情報の質問と未知の要求を拒否する', async () => {
    const { start, server, events } = setup(); await start();
    server.request(1, 'item/tool/requestUserInput', { questions: [{ id: 'secret', isSecret: true, question: '秘密の質問' }] });
    server.request(2, 'unknown/method', {});
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(server.messages.filter((m) => m.error?.code === -32601)).toHaveLength(2);
  });
});

describe('設定とトランスポート', () => {
  it('次のターンで設定が拒否されたら前の値へ戻す', async () => {
    const { start, server, events } = setup(); const session = await start();
    await session.send({ type: 'set_permission_mode', mode: 'full_auto' });
    await session.send({ type: 'set_model', effort: 'high' });
    server.handler = (m) => m.method === 'turn/start' ? { error: { code: -32602 } } : undefined;
    await expect(session.send({ type: 'send', text: '開始' })).rejects.toThrow();
    expect(events).toContainEqual({ type: 'permission_mode', mode: 'ask' });
    expect(events.filter((e) => e.type === 'model').at(-1)).toMatchObject({ effort: undefined });
  });
  it('auto が拒否されたら ask で開始し直す', async () => {
    const { start, server, events } = setup();
    server.handler = (m) => m.method === 'thread/start' && m.params.approvalsReviewer === 'auto_review' ? { error: { code: -32602 } } : undefined;
    await start({ permissionMode: 'auto' });
    expect(events).toContainEqual({ type: 'permission_mode', mode: 'ask' });
    expect(server.messages.filter((m) => m.method === 'thread/start')).toHaveLength(2);
    expect(server.messages.some((m) => m.method === 'turn/start')).toBe(false);
  });
  it.each(['ask', 'auto_edit', 'auto', 'full_auto', 'plan'] as const)('%s の設定を次のターンへ渡す', async (mode) => {
    const { start, server, events } = setup(); const session = await start();
    await session.send({ type: 'set_permission_mode', mode });
    await session.send({ type: 'send', text: '開始' });
    const params = server.messages.find((m) => m.method === 'turn/start')!.params;
    expect(params.approvalPolicy).toBe(mode === 'ask' ? 'untrusted' : ['full_auto', 'plan'].includes(mode) ? 'never' : 'on-request');
    expect(params.approvalsReviewer).toBe(mode === 'auto' ? 'auto_review' : 'user');
    expect(events).toContainEqual({ type: 'permission_mode', mode });
  });
  it('モデル、エフォートの変更と既定への復帰', async () => {
    const { start, server, events } = setup(); const session = await start();
    await session.send({ type: 'set_model', model: 'gpt-test', effort: 'high' });
    await session.send({ type: 'set_model', effort: 'max' });
    expect(events.at(-1)).toMatchObject({ type: 'model', model: 'gpt-test', effort: 'high' });
    await session.send({ type: 'set_model', model: null, effort: null });
    await session.send({ type: 'send', text: '開始' });
    expect(server.messages.find((m) => m.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-test', effort: 'medium', serviceTier: 'default' });
  });
  it('既定エフォートは選択モデルと有効な設定を使う', async () => {
    const { start, server, events } = setup();
    server.models.push({ id: 'other', model: 'other', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] });
    const session = await start();
    await session.send({ type: 'set_model', model: 'other' });
    expect(events.at(-1)).toMatchObject({ resolvedModel: 'other', resolvedEffort: 'high' });
    await session.send({ type: 'send', text: '開始' });
    expect(server.messages.find((m) => m.method === 'turn/start')?.params.effort).toBe('high');
  });
  it('破損 JSON、RPC エラー、タイムアウトを扱う', async () => {
    const server = new FakeServer(); const rpc = new RpcClient(server.launch(), 15);
    server.handler = () => ({ error: { code: -32602, message: '秘密情報' } });
    await expect(rpc.request('invalid')).rejects.toThrow('code: -32602');
    server.handler = () => ({ hold: true });
    await expect(rpc.request('timeout')).rejects.toThrow('タイムアウト');
    await rpc.close();
    const broken = new FakeServer(); const client = new RpcClient(broken.launch());
    const onFailure = vi.fn(); client.onFailure = onFailure;
    broken.child.stdout.write('invalid json\n'); await client.close();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
