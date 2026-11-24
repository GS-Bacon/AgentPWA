// SessionManager と認証の確認（Driver はテスト用のものを使う）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDriver, DriverEvent, DriverSession, StartOptions, UserAction } from '@agentpwa/shared';
import { checkRequest, hostnameOf } from '../src/auth.ts';
import { findAllowedFolder, type HubConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { SessionManager } from '../src/sessions.ts';

/** 操作を記録し、テストから任意のイベントを出せる Driver */
class TestDriver implements AgentDriver {
  readonly kind = 'claude' as const;
  auth: Awaited<ReturnType<AgentDriver['checkAuth']>> = { ok: true, auth: 'subscription' };
  starts: StartOptions[] = [];
  actions: UserAction[] = [];
  emit: (e: DriverEvent) => void = () => {};
  async checkAuth() {
    return this.auth;
  }
  async start(opts: StartOptions, emit: (e: DriverEvent) => void): Promise<DriverSession> {
    this.starts.push(opts);
    this.emit = emit;
    emit({ type: 'status', status: 'starting' });
    emit({ type: 'resume_token', token: opts.resumeToken ?? `token-${opts.sessionId}` });
    emit({ type: 'status', status: opts.initialPrompt ? 'running' : 'idle' });
    return {
      send: async (a) => {
        this.actions.push(a);
        if (a.type === 'send') emit({ type: 'status', status: 'running' });
      },
      stop: async () => emit({ type: 'status', status: 'stopped' }),
    };
  }
}

let dir: string;
let config: HubConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-test-'));
  config = {
    port: 0,
    machineName: 'laptop',
    allowedUsers: ['me@example.com'],
    allowLocalhost: true,
    folders: [
      { name: 'proj', path: path.join(dir, 'proj'), agent: 'claude' },
      { name: 'cx', path: path.join(dir, 'cx'), agent: 'codex' },
    ],
    codex: 'fake',
    dataDir: dir,
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(driver = new TestDriver()) {
  const store = new Store(path.join(dir, 'hub.db'));
  const manager = new SessionManager(store, new Map([['claude', driver]]), config);
  manager.init();
  return { store, manager, driver };
}

describe('SessionManager', () => {
  it('許可リストに無いフォルダでは起動しない', async () => {
    const { manager, store } = setup();
    await expect(manager.create({ agent: 'claude', cwd: path.join(dir, 'other'), permissionMode: 'ask' })).rejects.toThrow('許可リスト');
    store.close();
  });

  it('AI はプロジェクトの設定で決まり、違う AI は指定できない', async () => {
    const { manager, store } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask' });
    expect(s.agent).toBe('claude');
    await expect(manager.create({ agent: 'claude', cwd: config.folders[1].path, permissionMode: 'ask' })).rejects.toThrow('codex 用');
    store.close();
  });

  it('API キー方式なら起動しない', async () => {
    const driver = new TestDriver();
    driver.auth = { ok: false, auth: 'api_key', detail: 'ANTHROPIC_API_KEY が設定されています' };
    const { manager, store } = setup(driver);
    await expect(manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask' })).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(driver.starts).toHaveLength(0);
    store.close();
  });

  it('許可待ちのセッションが一覧の先頭に来て、許可すると戻る', async () => {
    const { manager, store, driver } = setup();
    const a = await manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'A' });
    const emitA = driver.emit;
    const b = await manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'B' });
    expect(manager.list().map((s) => s.status)).toEqual(['running', 'running']);

    driver.emit({ type: 'approval_request', requestId: 'p1', kind: 'command', title: 'コマンドの実行許可', command: 'npm i', choices: ['allow', 'deny'] });
    driver.emit({ type: 'status', status: 'waiting_approval' });
    const list = manager.list();
    expect(list[0].id).toBe(b.id);
    expect(list[0].rank).toBe(1);
    expect(list[0].pendingApprovals[0].command).toBe('npm i');

    await manager.action(b.id, { type: 'approve', requestId: 'p1', decision: 'allow' });
    expect(driver.actions).toContainEqual({ type: 'approve', requestId: 'p1', decision: 'allow' });
    driver.emit({ type: 'approval_resolved', requestId: 'p1', decision: 'allow' });
    driver.emit({ type: 'status', status: 'running' });
    expect(manager.get(b.id).rank).toBe(4);

    emitA({ type: 'status', status: 'idle' });
    expect(manager.list()[0].id).toBe(a.id);
    expect(manager.list()[0].unread).toBe(true);
    manager.read(a.id);
    expect(manager.get(a.id).unread).toBe(false);
    store.close();
  });

  it('イベントは seq 付きで保存され、after で差分を取れる', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    driver.emit({ type: 'message_delta', messageId: 'm1', text: 'こん' });
    driver.emit({ type: 'message_delta', messageId: 'm1', text: 'にちは' });
    const all = manager.events(s.id, 0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    driver.emit({ type: 'message', messageId: 'm1', role: 'assistant', text: 'こんにちは' });
    const after = manager.events(s.id, all[all.length - 1].seq);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ type: 'message', text: 'こんにちは' });
    // 完成版が来たら断片は保存から消える
    expect(manager.events(s.id, 0).some((e) => e.type === 'message_delta')).toBe(false);
    store.close();
  });

  it('Hub を再起動しても履歴が残り、送信すると resume_token で再開する', async () => {
    const first = setup();
    const s = await first.manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    first.driver.emit({ type: 'message', messageId: 'm1', role: 'assistant', text: '途中です' });
    const lastSeq = first.manager.get(s.id).lastSeq;
    first.store.close();

    // 2回目の Hub（同じ DB）
    const second = setup(new TestDriver());
    const restored = second.manager.get(s.id);
    expect(restored.status).toBe('stopped');
    expect(restored.statusReason).toContain('再起動');
    expect(restored.resumable).toBe(true);
    expect(restored.live).toBe(false);
    const events = second.manager.events(s.id, 0);
    expect(events.some((e) => e.type === 'message' && e.text === '途中です')).toBe(true);
    expect(events[events.length - 1].seq).toBe(lastSeq + 1);

    await second.manager.action(s.id, { type: 'send', text: '続けて' });
    expect(second.driver.starts[0].resumeToken).toBe(`token-${s.id}`);
    expect(second.driver.actions).toContainEqual({ type: 'send', text: '続けて' });
    expect(second.manager.get(s.id).live).toBe(true);
    second.store.close();
  });

  it('動いていないセッションへの許可操作はエラー', async () => {
    const first = setup();
    const s = await first.manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask' });
    await first.manager.stop(s.id);
    await expect(first.manager.action(s.id, { type: 'approve', requestId: 'x', decision: 'allow' })).rejects.toThrow('動いていません');
    first.store.close();
  });
});

describe('認証', () => {
  const s = { allowedUsers: ['Me@Example.com'], allowLocalhost: true };

  it('許可したユーザーは通す（大文字小文字は区別しない）', () => {
    expect(checkRequest({ 'tailscale-user-login': 'me@example.com', host: 'pc.tail1234.ts.net' }, s)).toEqual({ ok: true, user: 'me@example.com' });
  });

  it('許可していないユーザーは 403', () => {
    expect(checkRequest({ 'tailscale-user-login': 'other@example.com', host: 'pc.tail1234.ts.net' }, s)).toMatchObject({ ok: false, status: 403 });
  });

  it('ヘッダーなしは localhost からだけ通す', () => {
    expect(checkRequest({ host: '127.0.0.1:8787' }, s)).toEqual({ ok: true });
    expect(checkRequest({ host: 'localhost:5173' }, s)).toEqual({ ok: true });
    expect(checkRequest({ host: 'pc.tail1234.ts.net' }, s)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest({ host: 'evil.example.com' }, s)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest({ host: '127.0.0.1:8787', 'x-forwarded-for': '100.64.0.2' }, s)).toMatchObject({ ok: false });
    expect(checkRequest({ host: '127.0.0.1:8787' }, { ...s, allowLocalhost: false })).toMatchObject({ ok: false });
  });

  it('Host からホスト名を取り出す', () => {
    expect(hostnameOf('127.0.0.1:8787')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:8787')).toBe('[::1]');
    expect(hostnameOf('PC.ts.net')).toBe('pc.ts.net');
  });
});

describe('フォルダの許可リスト', () => {
  it('完全一致だけを許す', () => {
    const c = { folders: [{ name: 'a', path: path.resolve('/work/a'), agent: 'claude' }] } as HubConfig;
    expect(findAllowedFolder(c, path.resolve('/work/a'))?.name).toBe('a');
    expect(findAllowedFolder(c, path.resolve('/work/a/sub'))).toBeUndefined();
    expect(findAllowedFolder(c, path.resolve('/work/a/../b'))).toBeUndefined();
  });
});
