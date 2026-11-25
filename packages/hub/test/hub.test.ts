// SessionManager と認証の確認（Driver はテスト用のものを使う）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDriver, DriverEvent, DriverSession, StartOptions, UserAction } from '@agentpwa/shared';
import { checkRequest, hostnameOf } from '../src/auth.ts';
import { findAllowedFolder, isModeAllowed, loadConfig, type HubConfig } from '../src/config.ts';
import { createFakeDriver } from '../src/fake-driver.ts';
import { Store } from '../src/db.ts';
import { SessionManager } from '../src/sessions.ts';

/** 操作を記録し、テストから任意のイベントを出せる Driver */
class TestDriver implements AgentDriver {
  readonly kind = 'claude' as const;
  auth: Awaited<ReturnType<AgentDriver['checkAuth']>> = { ok: true, auth: 'subscription' };
  starts: StartOptions[] = [];
  actions: UserAction[] = [];
  stops = 0;
  deleted: { cwd: string; resumeToken: string }[] = [];
  deleteError: Error | null = null;
  /** 起動を失敗させる（reportFatal なら Driver 自身も致命的なエラーを出す） */
  startError: { message: string; reportFatal: boolean } | null = null;
  emit: (e: DriverEvent) => void = () => {};
  async deleteHistory(target: { cwd: string; resumeToken: string }) {
    this.deleted.push(target);
    if (this.deleteError) throw this.deleteError;
  }
  async checkAuth() {
    return this.auth;
  }
  lastModel: { model?: string; effort?: StartOptions['effort'] } = {};
  async start(opts: StartOptions, emit: (e: DriverEvent) => void): Promise<DriverSession> {
    this.starts.push(opts);
    this.emit = emit;
    this.lastModel = { model: opts.model, effort: opts.effort };
    emit({ type: 'status', status: 'starting' });
    if (this.startError) {
      if (this.startError.reportFatal) {
        emit({ type: 'error', message: this.startError.message, fatal: true });
        emit({ type: 'status', status: 'error' });
      }
      throw new Error(this.startError.message);
    }
    emit({ type: 'resume_token', token: opts.resumeToken ?? `token-${opts.sessionId}` });
    emit({ type: 'permission_mode', mode: opts.permissionMode });
    emit({ type: 'status', status: opts.initialPrompt ? 'running' : 'idle' });
    return {
      send: async (a) => {
        this.actions.push(a);
        if (a.type === 'send') emit({ type: 'status', status: 'running' });
        if (a.type === 'set_permission_mode') emit({ type: 'permission_mode', mode: a.mode });
        if (a.type === 'set_model') {
          const ev: DriverEvent = { type: 'model' };
          const model = a.model === undefined ? this.lastModel.model : a.model ?? undefined;
          const effort = a.effort === undefined ? this.lastModel.effort : a.effort ?? undefined;
          if (model) ev.model = model;
          if (effort) ev.effort = effort;
          this.lastModel = { model, effort };
          emit(ev);
        }
      },
      stop: async () => {
        this.stops++;
        emit({ type: 'status', status: 'stopped' });
      },
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
      { name: 'free', path: path.join(dir, 'free'), agent: 'claude', allowFullAuto: true, defaultPermissionMode: 'auto_edit' },
    ],
    projectRoots: [],
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

  it('AI はプロジェクトの設定で決まり、そのフォルダを登録していない AI は指定できない', async () => {
    const { manager, store } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask' });
    expect(s.agent).toBe('claude');
    await expect(manager.create({ agent: 'claude', cwd: config.folders[1].path, permissionMode: 'ask' })).rejects.toThrow('claude のプロジェクトとして登録されていません');
    store.close();
  });

  it('同じフォルダを Claude と Codex の両方で登録すると、agent でどちらのプロジェクトか選べる', async () => {
    const shared = path.join(dir, 'shared');
    config.folders.push(
      { name: 'shared-cx', path: shared, agent: 'codex' },
      { name: 'shared', path: shared, agent: 'claude', allowFullAuto: true },
    );
    const { manager, store } = setup();
    const s = await manager.create({ agent: 'claude', cwd: shared, permissionMode: 'full_auto' });
    expect(s).toMatchObject({ agent: 'claude', folderName: 'shared', permissionMode: 'full_auto' });
    // codex 側のプロジェクトは full_auto を許していない
    await expect(manager.create({ agent: 'codex', cwd: shared, permissionMode: 'full_auto' })).rejects.toThrow();
    // agent を省くと、作成元と同じ AI のプロジェクト
    const child = await manager.create({ cwd: shared, permissionMode: 'ask' }, s.id);
    expect(child).toMatchObject({ agent: 'claude', folderName: 'shared' });
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

  it('再開に失敗したとき、Driver が伝えたエラーは二重に記録せず、伝えなかったときは Hub が記録する', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await manager.stop(s.id);
    const errorsAfter = (seq: number) => manager.events(s.id, seq).filter((e) => e.type === 'error');

    driver.startError = { message: 'スレッドは別のプロセスで開かれています', reportFatal: true };
    let seq = manager.get(s.id).lastSeq;
    await expect(manager.action(s.id, { type: 'send', text: '続けて' })).rejects.toThrow();
    expect(errorsAfter(seq)).toHaveLength(1);
    expect(manager.get(s.id).status).toBe('error');
    expect(manager.get(s.id).lastError).toBe('スレッドは別のプロセスで開かれています');

    driver.startError = { message: '起動に失敗', reportFatal: false };
    seq = manager.get(s.id).lastSeq;
    await expect(manager.action(s.id, { type: 'send', text: 'もう一度' })).rejects.toThrow();
    expect(errorsAfter(seq).map((e) => e.type === 'error' && e.message)).toEqual(['起動できませんでした: 起動に失敗']);
    expect(manager.get(s.id).status).toBe('error');
    store.close();
  });

  it('動いていないセッションへの許可操作はエラー', async () => {
    const first = setup();
    const s = await first.manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await first.manager.stop(s.id);
    await expect(first.manager.action(s.id, { type: 'approve', requestId: 'x', decision: 'allow' })).rejects.toThrow('動いていません');
    first.store.close();
  });
});

describe('モデルとエフォート', () => {
  it('起動時のモデルとエフォートを Driver に渡す', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, model: 'opus', effort: 'high', prompt: 'hi' });
    expect(driver.starts[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(manager.get(s.id)).toMatchObject({ model: 'opus', effort: 'high' });
    store.close();
  });

  it('使えない文字のモデル名と、知らないエフォートは拒否する', async () => {
    const { manager, store, driver } = setup();
    await expect(manager.create({ cwd: config.folders[0].path, model: 'opus --dangerously' })).rejects.toThrow('モデル名');
    // @ts-expect-error 知らない値
    await expect(manager.create({ cwd: config.folders[0].path, effort: 'huge' })).rejects.toThrow('エフォート');
    const s = await manager.create({ cwd: config.folders[0].path, prompt: 'hi' });
    await expect(manager.action(s.id, { type: 'set_model', model: 'a b' })).rejects.toThrow('モデル名');
    expect(driver.actions.some((a) => a.type === 'set_model')).toBe(false);
    store.close();
  });

  it('set_model を Driver に渡し、反映された値になる（省略は変えず、null は既定に戻す）', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, model: 'opus', prompt: 'hi' });
    await manager.action(s.id, { type: 'set_model', effort: 'max' });
    expect(driver.actions).toContainEqual({ type: 'set_model', effort: 'max' });
    expect(manager.get(s.id)).toMatchObject({ model: 'opus', effort: 'max' });
    await manager.action(s.id, { type: 'set_model', model: null });
    expect(manager.get(s.id).model).toBeUndefined();
    expect(manager.get(s.id).effort).toBe('max');
    store.close();
  });

  it('止まっているセッションの設定は Hub が覚えて、次の起動で渡す', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, model: 'opus', prompt: 'hi' });
    await manager.stop(s.id);
    await manager.action(s.id, { type: 'set_model', model: 'sonnet', effort: 'low' });
    expect(manager.get(s.id)).toMatchObject({ model: 'sonnet', effort: 'low', live: false });
    await manager.action(s.id, { type: 'send', text: '再開' });
    expect(driver.starts[1]).toMatchObject({ model: 'sonnet', effort: 'low' });
    store.close();
  });
});

describe('権限モード', () => {
  it('Driver の permission_mode を現在のモードとして保存し、再起動後も残る', async () => {
    const first = setup();
    const s = await first.manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    expect(first.manager.get(s.id).permissionMode).toBe('ask');
    // エージェント自身がモードを変えた（例: 計画モードの終了）ときも追う
    first.driver.emit({ type: 'permission_mode', mode: 'plan' });
    expect(first.manager.get(s.id).permissionMode).toBe('plan');
    first.store.close();

    const second = setup(new TestDriver());
    expect(second.manager.get(s.id).permissionMode).toBe('plan');
    // 次の再開では、保存したモードを渡す
    await second.manager.action(s.id, { type: 'send', text: '続けて' });
    expect(second.driver.starts[0].permissionMode).toBe('plan');
    second.store.close();
  });

  it('set_permission_mode を Driver に渡し、反映されたモードになる', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await manager.action(s.id, { type: 'set_permission_mode', mode: 'auto' });
    expect(driver.actions).toContainEqual({ type: 'set_permission_mode', mode: 'auto' });
    expect(manager.get(s.id).permissionMode).toBe('auto');
    store.close();
  });

  it('切り替えに失敗したら（error のみで permission_mode が来なければ）元のモードのまま', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'auto_edit', prompt: 'hi' });
    driver.emit({ type: 'error', message: 'このプランでは自動承認を使えません', fatal: false });
    expect(manager.get(s.id).permissionMode).toBe('auto_edit');
    store.close();
  });

  it('止まっているセッションのモードは Hub が覚えて、次の起動で渡す', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await manager.stop(s.id);
    await manager.action(s.id, { type: 'set_permission_mode', mode: 'auto_edit' });
    expect(manager.get(s.id).permissionMode).toBe('auto_edit');
    expect(manager.get(s.id).live).toBe(false);
    await manager.action(s.id, { type: 'send', text: '再開' });
    expect(driver.starts[1].permissionMode).toBe('auto_edit');
    store.close();
  });

  it('full_auto は許可したプロジェクトでだけ使え、それ以外は Driver に渡さない', async () => {
    const { manager, store, driver } = setup();
    // 起動時
    await expect(manager.create({ cwd: config.folders[0].path, permissionMode: 'full_auto' })).rejects.toThrow('すべて自動');
    expect(driver.starts).toHaveLength(0);
    // 切り替え
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await expect(manager.action(s.id, { type: 'set_permission_mode', mode: 'full_auto' })).rejects.toThrow('すべて自動');
    expect(driver.actions.some((a) => a.type === 'set_permission_mode')).toBe(false);
    expect(manager.get(s.id).permissionMode).toBe('ask');
    // auto（自動承認）はフォルダの制限なし
    await manager.action(s.id, { type: 'set_permission_mode', mode: 'auto' });
    expect(manager.get(s.id).permissionMode).toBe('auto');

    // 許可したプロジェクトでは使える
    const f = await manager.create({ cwd: config.folders[2].path, permissionMode: 'full_auto', prompt: 'hi' });
    expect(driver.starts[driver.starts.length - 1].permissionMode).toBe('full_auto');
    expect(manager.get(f.id).permissionMode).toBe('full_auto');
    store.close();
  });

  it('モードを省略するとプロジェクトの既定で始める', async () => {
    const { manager, store } = setup();
    const a = await manager.create({ cwd: config.folders[0].path });
    expect(a.permissionMode).toBe('auto');
    const b = await manager.create({ cwd: config.folders[2].path });
    expect(b.permissionMode).toBe('auto_edit');
    store.close();
  });

  it('full_auto の許可が外れたプロジェクトのセッションは、再開時に「毎回確認」で起動する', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[2].path, permissionMode: 'full_auto', prompt: 'hi' });
    await manager.stop(s.id);
    config.folders[2] = { ...config.folders[2], allowFullAuto: false };
    await manager.action(s.id, { type: 'send', text: '再開' });
    expect(driver.starts[1].permissionMode).toBe('ask');
    expect(manager.get(s.id).permissionMode).toBe('ask');
    store.close();
  });

  it('フェイク Driver: 起動時と切り替え時に permission_mode を送り、deleteHistory を記録する', async () => {
    const fx = path.join(dir, 'fx');
    fs.mkdirSync(fx);
    fs.writeFileSync(path.join(fx, '01.jsonl'), '{"type":"status","status":"idle"}\n');
    const fake = createFakeDriver({ kind: 'claude', fixturesDir: fx, delayMs: 0 });
    const events: DriverEvent[] = [];
    const s = await fake.start({ sessionId: 'x', cwd: dir, permissionMode: 'plan' }, (e) => events.push(e));
    expect(events[0]).toEqual({ type: 'permission_mode', mode: 'plan' });
    await s.send({ type: 'set_permission_mode', mode: 'auto' });
    expect(events).toContainEqual({ type: 'permission_mode', mode: 'auto' });
    await s.stop();
    await fake.deleteHistory!({ cwd: dir, resumeToken: 't' });
    expect(fake.deletedHistories).toEqual([{ cwd: dir, resumeToken: 't' }]);
  });
});

describe('アーカイブと削除', () => {
  it('アーカイブは動いているセッションを止め、解除しても stopped のまま。送信で resume_token から再開する', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    expect(manager.get(s.id).status).toBe('running');
    const archived = await manager.update(s.id, { archived: true });
    expect(driver.stops).toBe(1);
    expect(archived).toMatchObject({ archived: true, status: 'stopped', live: false });
    // アーカイブ中は送信・再開できない
    await expect(manager.action(s.id, { type: 'send', text: 'x' })).rejects.toThrow('アーカイブ');
    await expect(manager.resume(s.id)).rejects.toThrow('アーカイブ');

    const restored = await manager.update(s.id, { archived: false });
    expect(restored).toMatchObject({ archived: false, status: 'stopped' });
    await manager.action(s.id, { type: 'send', text: '続けて' });
    expect(driver.starts[1].resumeToken).toBe(`token-${s.id}`);
    store.close();
  });

  it('止まっているセッションのアーカイブでは stop を呼ばない', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await manager.stop(s.id);
    expect(driver.stops).toBe(1);
    await manager.update(s.id, { archived: true });
    expect(driver.stops).toBe(1);
    store.close();
  });

  it('削除は止めてから Hub の記録を消し、deleteHistory に cwd と resume_token を渡す', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    const removed: string[] = [];
    manager.on('removed', (id) => removed.push(id));
    const r = await manager.remove(s.id);
    expect(r).toEqual({ ok: true });
    expect(driver.stops).toBe(1);
    expect(driver.deleted).toEqual([{ cwd: config.folders[0].path, resumeToken: `token-${s.id}` }]);
    expect(removed).toEqual([s.id]);
    expect(() => manager.get(s.id)).toThrow('見つかりません');
    expect(store.eventsAfter(s.id, 0)).toEqual([]);
    expect(store.loadSessions()).toEqual([]);
    store.close();
  });

  it('deleteHistory が失敗しても Hub 側の削除は取り消さず、理由を返す', async () => {
    const driver = new TestDriver();
    driver.deleteError = new Error('履歴のファイルを消せませんでした');
    const { manager, store } = setup(driver);
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    const r = await manager.remove(s.id);
    expect(r).toEqual({ ok: true, historyError: '履歴のファイルを消せませんでした' });
    expect(manager.list()).toEqual([]);
    expect(store.loadSessions()).toEqual([]);
    store.close();
  });

  it('削除したセッションは Hub を再起動しても戻らない', async () => {
    const first = setup();
    const keep = await first.manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    const gone = await first.manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'hi' });
    await first.manager.remove(gone.id);
    first.store.close();
    const second = setup(new TestDriver());
    expect(second.manager.list().map((s) => s.id)).toEqual([keep.id]);
    second.store.close();
  });
});

describe('ピン止めと未読', () => {
  it('ピン止めは一覧の先頭に来て、未読の印は既読にすると外れる。どちらも再起動後も残る', async () => {
    const first = setup();
    const a = await first.manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'a' });
    const b = await first.manager.create({ cwd: config.folders[0].path, permissionMode: 'ask', prompt: 'b' });
    await first.manager.stop(a.id);
    await first.manager.stop(b.id);
    expect(await first.manager.update(a.id, { pinned: true })).toMatchObject({ pinned: true });
    expect(await first.manager.update(b.id, { unread: true })).toMatchObject({ unread: true, markedUnread: true, rank: 3 });
    expect(first.manager.list().map((s) => s.id)).toEqual([a.id, b.id]);
    first.store.close();

    const second = setup(new TestDriver());
    expect(second.manager.get(a.id).pinned).toBe(true);
    expect(second.manager.get(b.id).markedUnread).toBe(true);
    // 開いて既読にすると印が外れる（新しいイベントが無くても）
    expect(second.manager.read(b.id)).toMatchObject({ unread: false, markedUnread: false, rank: 5 });
    expect(await second.manager.update(a.id, { pinned: false })).toMatchObject({ pinned: false });
    second.store.close();
  });
});

describe('設定ファイル', () => {
  const write = (folders: unknown[]) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ folders }));
    return file;
  };

  it('allowFullAuto と defaultPermissionMode を補い、full_auto の可否を判定する', () => {
    const file = write([
      { path: path.join(dir, 'a') },
      { path: path.join(dir, 'b'), allowFullAuto: true, defaultPermissionMode: 'full_auto' },
    ]);
    const { config: c } = loadConfig(file);
    expect(c.folders[0]).toMatchObject({ agent: 'claude', allowFullAuto: false, defaultPermissionMode: 'auto' });
    expect(c.folders[1]).toMatchObject({ allowFullAuto: true, defaultPermissionMode: 'full_auto' });
    expect(isModeAllowed(c, path.join(dir, 'a'), 'claude', 'full_auto')).toBe(false);
    expect(isModeAllowed(c, path.join(dir, 'a'), 'claude', 'auto')).toBe(true);
    expect(isModeAllowed(c, path.join(dir, 'b'), 'claude', 'full_auto')).toBe(true);
    // 同じフォルダでも、別の AI のプロジェクト（ここでは未登録）では許さない
    expect(isModeAllowed(c, path.join(dir, 'b'), 'codex', 'full_auto')).toBe(false);
    expect(isModeAllowed(c, path.join(dir, 'other'), 'claude', 'full_auto')).toBe(false);
  });

  it('同じフォルダは AI ごとに1つまで登録できる', () => {
    const ok = write([{ path: path.join(dir, 'a') }, { path: path.join(dir, 'a'), agent: 'codex' }]);
    expect(loadConfig(ok).config.folders.map((f) => f.agent)).toEqual(['claude', 'codex']);
    const dup = write([{ path: path.join(dir, 'a') }, { path: path.join(dir, 'a') + path.sep, agent: 'claude' }]);
    expect(() => loadConfig(dup)).toThrow('同じフォルダと AI');
  });

  it('許可していないプロジェクトの既定を full_auto にはできない', () => {
    const file = write([{ path: path.join(dir, 'a'), defaultPermissionMode: 'full_auto' }]);
    expect(() => loadConfig(file)).toThrow('allowFullAuto');
    const bad = write([{ path: path.join(dir, 'a'), defaultPermissionMode: 'yolo' }]);
    expect(() => loadConfig(bad)).toThrow('defaultPermissionMode');
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

describe('空のセッション', () => {
  it('最初の指示なしで作ったセッションは空。ユーザーが送信すると空でなくなる', async () => {
    const { manager, store, driver } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, permissionMode: 'ask' });
    expect(s.empty).toBe(true);
    driver.emit({ type: 'message', messageId: 'u1', role: 'user', text: 'CI を直して' });
    expect(manager.get(s.id)).toMatchObject({ empty: false, title: 'CI を直して' });
    expect(await manager.discardIfEmpty(s.id)).toBe(false);
    expect(manager.get(s.id).id).toBe(s.id);
    store.close();
  });

  it('空のセッションは discardIfEmpty・停止・アーカイブで消える', async () => {
    const { manager, store } = setup();
    const removed: string[] = [];
    manager.on('removed', (id) => removed.push(id));
    const a = await manager.create({ cwd: config.folders[0].path });
    const b = await manager.create({ cwd: config.folders[0].path });
    const c = await manager.create({ cwd: config.folders[0].path });
    expect(await manager.discardIfEmpty(a.id)).toBe(true);
    await manager.stop(b.id);
    await manager.update(c.id, { archived: true });
    expect(removed).toEqual([a.id, b.id, c.id]);
    expect(manager.list()).toEqual([]);
    expect(store.loadSessions()).toEqual([]);
    store.close();
  });

  it('名前を付けたセッションは空とみなさない', async () => {
    const { manager, store } = setup();
    const s = await manager.create({ cwd: config.folders[0].path });
    await manager.update(s.id, { title: '調査用' });
    expect(await manager.discardIfEmpty(s.id)).toBe(false);
    store.close();
  });

  it('Hub の起動時に、前回の空のセッションを消す（started の無い古い記録は名前で判断する）', async () => {
    const first = setup();
    const empty = await first.manager.create({ cwd: config.folders[0].path });
    const keep = await first.manager.create({ cwd: config.folders[0].path, prompt: 'hi' });
    // 古い形の記録（started なし）
    const old = { ...first.store.loadSessions().find((r) => r.id === keep.id)!, id: 'old-1', title: '別の名前' } as Record<string, unknown>;
    delete old.started;
    first.store.saveSession(old as never);
    first.store.close();
    const second = setup(new TestDriver());
    const ids = second.manager.list().map((s) => s.id);
    expect(ids).not.toContain(empty.id);
    expect(ids).toEqual(expect.arrayContaining([keep.id, 'old-1']));
    second.store.close();
  });
});

describe('AI からのセッション作成', () => {
  it('作成元を記録し、cwd を省くと作成元と同じフォルダで始める', async () => {
    const { manager, store } = setup();
    const parent = await manager.create({ cwd: config.folders[2].path, prompt: 'hi' });
    const child = await manager.create({ cwd: '', prompt: '別の作業' }, parent.id);
    expect(child).toMatchObject({ parentSessionId: parent.id, cwd: config.folders[2].path, empty: false });
    await expect(manager.create({ cwd: '', prompt: 'x' }, 'no-such')).rejects.toThrow('作成元');
    store.close();
  });

  it('作成元が「すべて自動」でなければ「すべて自動」のセッションは作れない', async () => {
    const { manager, store } = setup();
    const parent = await manager.create({ cwd: config.folders[2].path, permissionMode: 'ask', prompt: 'hi' });
    await expect(manager.create({ cwd: '', permissionMode: 'full_auto', prompt: 'x' }, parent.id)).rejects.toThrow('すべて自動');
    const auto = await manager.create({ cwd: config.folders[2].path, permissionMode: 'full_auto', prompt: 'hi' });
    const child = await manager.create({ cwd: '', permissionMode: 'full_auto', prompt: 'x' }, auto.id);
    expect(child.permissionMode).toBe('full_auto');
    store.close();
  });
});

/** 巻き戻しとフォークに対応した Driver（v11） */
class RewindDriver extends TestDriver {
  readonly supportsRewind = true;
  forks: { cwd: string; resumeToken: string; messageId: string }[] = [];
  async forkToken(target: { cwd: string; resumeToken: string; messageId: string }) {
    this.forks.push(target);
    return `${target.resumeToken}|at=x|fork`;
  }
}

describe('巻き戻しとフォーク（v11）', () => {
  /** u1 → a1 → u2 → a2 の2ターンを終えたセッション */
  async function twoTurns(driver: RewindDriver) {
    const { manager, store } = setup(driver);
    const s = await manager.create({ cwd: config.folders[0].path, prompt: 'hi' });
    driver.emit({ type: 'message', messageId: 'u1', role: 'user', text: '一つ目', rewindable: true });
    driver.emit({ type: 'tool', toolId: 't1', name: 'Edit', summary: 'a.txt', state: 'done' });
    driver.emit({ type: 'message', messageId: 'a1', role: 'assistant', text: '答え1' });
    driver.emit({ type: 'status', status: 'idle' });
    driver.emit({ type: 'message', messageId: 'u2', role: 'user', text: '二つ目', rewindable: true });
    driver.emit({ type: 'message', messageId: 'a2', role: 'assistant', text: '答え2' });
    driver.emit({ type: 'status', status: 'idle' });
    return { manager, store, s };
  }

  it('巻き戻しは作業中には受け付けず、rewindable な発言だけを Driver に渡す', async () => {
    const driver = new RewindDriver();
    const { manager, store, s } = await twoTurns(driver);
    await expect(manager.action(s.id, { type: 'rewind', messageId: 'nope', restore: 'both' })).rejects.toThrow('巻き戻せません');
    driver.emit({ type: 'status', status: 'running' });
    await expect(manager.action(s.id, { type: 'rewind', messageId: 'u2', restore: 'both' })).rejects.toThrow('作業中');
    driver.emit({ type: 'status', status: 'idle' });
    await manager.action(s.id, { type: 'rewind', messageId: 'u2', restore: 'conversation' });
    expect(driver.actions).toContainEqual({ type: 'rewind', messageId: 'u2', restore: 'conversation' });
    store.close();
  });

  it('対応していない Driver では巻き戻せず、フォークもできない', async () => {
    const { manager, store } = setup();
    const s = await manager.create({ cwd: config.folders[0].path, prompt: 'hi' });
    await expect(manager.action(s.id, { type: 'rewind', messageId: 'u1', restore: 'both' })).rejects.toThrow('巻き戻せません');
    await expect(manager.fork(s.id, 'u1')).rejects.toThrow('フォーク');
    expect(manager.features('claude')).toMatchObject({ rewind: false, fork: false });
    store.close();
  });

  it('フォークは発言のターンの終わりまでを写し、Driver の resumeToken で新しいセッションを作る', async () => {
    const driver = new RewindDriver();
    const { manager, store, s } = await twoTurns(driver);
    const f = await manager.fork(s.id, 'u1');
    expect(driver.forks[0]).toEqual({ cwd: config.folders[0].path, resumeToken: `token-${s.id}`, messageId: 'u1' });
    expect(f).toMatchObject({ title: `${manager.get(s.id).title}（フォーク）`, status: 'idle', live: false, resumable: true, empty: false });
    const texts = manager.events(f.id, 0).filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.text : ''));
    expect(texts).toEqual(['一つ目', '答え1']);
    expect(manager.events(f.id, 0).some((e) => e.type === 'tool')).toBe(true);
    // 送信すると、受け取った resumeToken で起動する
    await manager.action(f.id, { type: 'send', text: '続き' });
    expect(driver.starts[driver.starts.length - 1].resumeToken).toBe(`token-${s.id}|at=x|fork`);
    store.close();
  });

  it('巻き戻した発言（rewound の後）からはフォークできず、写す会話にも入らない', async () => {
    const driver = new RewindDriver();
    const { manager, store, s } = await twoTurns(driver);
    driver.emit({ type: 'rewound', messageId: 'u2' });
    await expect(manager.fork(s.id, 'u2')).rejects.toThrow('フォークできません');
    const f = await manager.fork(s.id, 'u1');
    const texts = manager.events(f.id, 0).filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.text : ''));
    expect(texts).toEqual(['一つ目', '答え1']);
    store.close();
  });

  it('まだ終わっていない最後のターンからはフォークできない', async () => {
    const driver = new RewindDriver();
    const { manager, store, s } = await twoTurns(driver);
    driver.emit({ type: 'status', status: 'running' });
    await expect(manager.fork(s.id, 'u2')).rejects.toThrow('終わって');
    await expect(manager.fork(s.id, 'u1')).resolves.toBeTruthy();
    store.close();
  });
});
