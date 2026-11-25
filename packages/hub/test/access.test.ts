// アクセスの許可（画面からの allowedUsers の編集）と、設定の自動設定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentDriver } from '@agentpwa/shared';
import { AccessRequests } from '../src/access.ts';
import { autoFillConfig } from '../src/autoconfig.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { SessionManager } from '../src/sessions.ts';
import { parseStatus } from '../src/tailscale.ts';

let dir: string;
let configPath: string;
let config: HubConfig;
let store: Store;
let app: FastifyInstance;
let notified: number;

const HOST = 'pc.tail1234.ts.net';
const as = (login: string, extra: Record<string, string> = {}) => ({ 'tailscale-user-login': login, host: HOST, ...extra });
const json = { 'content-type': 'application/json' };

const driver = (kind: 'claude' | 'codex'): AgentDriver => ({
  kind,
  checkAuth: async () => ({ ok: true, auth: 'subscription' }),
  start: async () => ({ send: async () => {}, stop: async () => {} }),
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-access-'));
  configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ allowedUsers: ['me@example.com'], folders: [], note: 'そのまま残す' }, null, 2));
  config = loadConfig(configPath).config;
  store = new Store(path.join(dir, 'hub.db'));
  const manager = new SessionManager(store, new Map([['claude', driver('claude')], ['codex', driver('codex')]]), config);
  manager.init();
  notified = 0;
  manager.on('config', () => notified++);
  app = await buildServer({ manager, config, configPath, fakeAgents: [] });
});

afterEach(async () => {
  await app.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const info = async () => (await app.inject({ method: 'GET', url: '/api/info', headers: as('me@example.com') })).json();

describe('許可されていないユーザー', () => {
  it('開こうとしたユーザーを許可待ちに覚え、許可された端末に知らせる', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/info', headers: as('friend@example.com', { 'tailscale-user-name': 'Friend' }) });
    expect(r.statusCode).toBe(403);
    expect(notified).toBe(1);
    // 同じユーザーが何度開いても、知らせるのは最初だけ
    await app.inject({ method: 'GET', url: '/api/sessions', headers: as('friend@example.com') });
    expect(notified).toBe(1);
    const i = await info();
    expect(i.access.allowedUsers).toEqual(['me@example.com']);
    expect(i.access.pending).toMatchObject([{ login: 'friend@example.com', name: 'Friend' }]);
  });

  it('ブラウザで開いたときは、理由と次にやることを書いたページを返す', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: as('<b>x@example.com', { accept: 'text/html,application/xhtml+xml' }) });
    expect(r.statusCode).toBe(403);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('設定 → アクセス');
    // ログイン名はエスケープする（形の正しくない名前は許可待ちにも入れない）
    expect(r.body).not.toContain('<b>x@');
    expect((await info()).access.pending).toEqual([]);
  });

  it('許可すると allowedUsers に書き足し、ほかの項目は残す。すぐに開けるようになる', async () => {
    await app.inject({ method: 'GET', url: '/api/info', headers: as('friend@example.com') });
    const r = await app.inject({ method: 'POST', url: '/api/access/allow', headers: { ...as('me@example.com'), ...json }, payload: { login: 'friend@example.com' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ allowedUsers: ['me@example.com', 'friend@example.com'], pending: [] });
    expect(raw()).toMatchObject({ allowedUsers: ['me@example.com', 'friend@example.com'], note: 'そのまま残す' });
    expect((await app.inject({ method: 'GET', url: '/api/info', headers: as('Friend@Example.com') })).statusCode).toBe(200);
  });

  it('許可されていないユーザーは、自分を許可できない', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/access/allow', headers: { ...as('evil@example.com'), ...json }, payload: { login: 'evil@example.com' } });
    expect(r.statusCode).toBe(403);
    expect(raw().allowedUsers).toEqual(['me@example.com']);
  });

  it('許可を取り消せる。自分自身は取り消せない', async () => {
    await app.inject({ method: 'POST', url: '/api/access/allow', headers: { ...as('me@example.com'), ...json }, payload: { login: 'friend@example.com' } });
    const self = await app.inject({ method: 'POST', url: '/api/access/revoke', headers: { ...as('me@example.com'), ...json }, payload: { login: 'ME@example.com' } });
    expect(self.statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/api/access/revoke', headers: { ...as('me@example.com'), ...json }, payload: { login: 'friend@example.com' } });
    expect(r.json().allowedUsers).toEqual(['me@example.com']);
    expect(raw().allowedUsers).toEqual(['me@example.com']);
    expect((await app.inject({ method: 'GET', url: '/api/info', headers: as('friend@example.com') })).statusCode).toBe(403);
  });

  it('無視すると許可待ちから消える（許可はしない）', async () => {
    await app.inject({ method: 'GET', url: '/api/info', headers: as('friend@example.com') });
    const r = await app.inject({ method: 'POST', url: '/api/access/dismiss', headers: { ...as('me@example.com'), ...json }, payload: { login: 'friend@example.com' } });
    expect(r.json()).toEqual({ allowedUsers: ['me@example.com'], pending: [] });
    expect(raw().allowedUsers).toEqual(['me@example.com']);
  });

  it('形の正しくないログイン名は断る', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/access/allow', headers: { ...as('me@example.com'), ...json }, payload: { login: 'a b' } });
    expect(r.statusCode).toBe(400);
  });
});

describe('許可待ちの一覧', () => {
  it('新しい順に並べ、20 件を超えたら古いものから消す', () => {
    const a = new AccessRequests();
    for (let i = 0; i < 25; i++) a.record(`u${i}@example.com`);
    a.record('u10@example.com');
    const l = a.list();
    expect(l).toHaveLength(20);
    expect(l[0].login).toBe('u10@example.com');
    expect(l.map((p) => p.login)).not.toContain('u4@example.com');
  });
});

describe('自動設定', () => {
  const ts = async () => ({ running: true, login: 'owner@example.com', dnsName: 'pc.tail1234.ts.net' });

  it('新しい設定ファイルには、Tailscale のユーザーとホームフォルダを入れる', async () => {
    const file = path.join(dir, 'new', 'config.json');
    const loaded = loadConfig(file);
    expect(loaded.created).toBe(true);
    const r = await autoFillConfig(file, { created: true, tailscale: ts, homeDir: dir });
    expect(r.changes).toHaveLength(2);
    const c = loadConfig(file).config;
    expect(c.allowedUsers).toEqual(['owner@example.com']);
    expect(c.projectRoots).toEqual([path.resolve(dir)]);
  });

  it('書かれている値は変えない。既存の設定ファイルの projectRoots は空のまま', async () => {
    const r = await autoFillConfig(configPath, { created: false, tailscale: ts, homeDir: dir });
    expect(r.changes).toEqual([]);
    expect(raw()).toMatchObject({ allowedUsers: ['me@example.com'], note: 'そのまま残す' });
    expect(raw().projectRoots).toBeUndefined();
  });

  it('allowedUsers が空なら、既存の設定ファイルにも入れる。Tailscale が無ければ何もしない', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ allowedUsers: [] }));
    expect((await autoFillConfig(configPath, { created: false, tailscale: async () => undefined })).changes).toEqual([]);
    expect(raw().allowedUsers).toEqual([]);
    await autoFillConfig(configPath, { created: false, tailscale: ts });
    expect(raw().allowedUsers).toEqual(['owner@example.com']);
  });

  it('tailscale status --json から、ログイン名と MagicDNS 名を取り出す', () => {
    const s = parseStatus({
      BackendState: 'Running',
      Self: { UserID: 123, DNSName: 'pc.tail1234.ts.net.' },
      User: { '123': { LoginName: 'owner@example.com' }, '456': { LoginName: 'other@example.com' } },
    });
    expect(s).toEqual({ running: true, login: 'owner@example.com', dnsName: 'pc.tail1234.ts.net' });
    expect(parseStatus({ BackendState: 'Stopped' })).toEqual({ running: false, login: undefined, dnsName: undefined });
  });
});
