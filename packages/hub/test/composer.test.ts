// 入力欄の機能（プロトコル v7）: 添付ファイルつきの送信と、スラッシュコマンドの一覧。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentDriver, DriverSession, SlashCommand, UserAction } from '@agentpwa/shared';
import type { HubConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { SessionManager } from '../src/sessions.ts';

let dir: string;
let store: Store;
let app: FastifyInstance;
let sent: UserAction[];
let listCalls: number;
let claudeSid: string;
let codexSid: string;

const H = { 'tailscale-user-login': 'me@example.com', host: 'laptop.example.ts.net', 'content-type': 'application/json' };

function driver(kind: 'claude' | 'codex', extra: Partial<AgentDriver>): AgentDriver {
  return {
    kind,
    checkAuth: async () => ({ ok: true, auth: 'subscription' }),
    start: async (): Promise<DriverSession> => ({
      send: async (a) => {
        sent.push(a);
      },
      stop: async () => {},
    }),
    ...extra,
  };
}

beforeEach(async () => {
  sent = [];
  listCalls = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-composer-'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  const config = {
    port: 0,
    machineName: 'laptop',
    allowedUsers: ['me@example.com'],
    allowLocalhost: false,
    folders: [
      { name: 'a', path: path.join(dir, 'a'), agent: 'claude' },
      { name: 'b', path: path.join(dir, 'b'), agent: 'codex' },
    ],
    projectRoots: [],
    codex: 'fake',
    dataDir: dir,
  } as unknown as HubConfig;
  const commands: SlashCommand[] = [{ name: 'compact', description: '会話を要約' }];
  const claude = driver('claude', {
    supportsAttachments: true,
    listCommands: async () => {
      listCalls++;
      return commands;
    },
  });
  const codex = driver('codex', {});
  store = new Store(path.join(dir, 'hub.db'));
  const manager = new SessionManager(store, new Map([['claude', claude], ['codex', codex]]), config);
  manager.init();
  claudeSid = (await manager.create({ cwd: config.folders[0].path })).id;
  codexSid = (await manager.create({ cwd: config.folders[1].path })).id;
  app = await buildServer({ manager, config, configPath: path.join(dir, 'config.json'), fakeAgents: [] });
});

afterEach(async () => {
  await app.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const action = (sid: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/sessions/${sid}/action`, headers: H, payload: payload as object });

describe('添付ファイルつきの送信', () => {
  it('本文が空でも添付があれば送れる', async () => {
    const r = await action(claudeSid, { type: 'send', text: '', attachments: [{ name: 'a.png', mimeType: 'image/png', data: 'iVBORw0K' }] });
    expect(r.statusCode).toBe(200);
    expect(sent.at(-1)).toEqual({ type: 'send', text: '', attachments: [{ name: 'a.png', mimeType: 'image/png', data: 'iVBORw0K' }] });
  });

  it('本文も添付も無い送信は断る', async () => {
    expect((await action(claudeSid, { type: 'send', text: '  ' })).statusCode).toBe(400);
    expect((await action(claudeSid, { type: 'send', text: '', attachments: [] })).statusCode).toBe(400);
  });

  it('形の正しくない添付・多すぎる添付は断る', async () => {
    expect((await action(claudeSid, { type: 'send', text: 'x', attachments: [{ name: '', mimeType: 'image/png', data: 'AA==' }] })).statusCode).toBe(400);
    expect((await action(claudeSid, { type: 'send', text: 'x', attachments: [{ name: 'a', mimeType: 'image/png', data: '<script>' }] })).statusCode).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, mimeType: 'text/plain', data: 'AA==' }));
    expect((await action(claudeSid, { type: 'send', text: 'x', attachments: many })).statusCode).toBe(400);
  });

  it('1MB を超える本文（添付）も受け付ける', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
    const r = await action(claudeSid, { type: 'send', text: 'x', attachments: [{ name: 'big.bin', mimeType: 'application/octet-stream', data }] });
    expect(r.statusCode).toBe(200);
  });

  it('添付に対応していない Driver のセッションでは断る', async () => {
    const r = await action(codexSid, { type: 'send', text: 'x', attachments: [{ name: 'a.png', mimeType: 'image/png', data: 'AA==' }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('添付');
  });
});

describe('スラッシュコマンド', () => {
  it('Driver に聞いた一覧を返し、作業フォルダごとに覚えておく', async () => {
    const get = () => app.inject({ method: 'GET', url: `/api/sessions/${claudeSid}/commands`, headers: H });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.json()).toEqual([{ name: 'compact', description: '会話を要約' }]);
    expect(b.json()).toEqual(a.json());
    await get();
    expect(listCalls).toBe(1);
  });

  it('対応していない Driver では空', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/sessions/${codexSid}/commands`, headers: H });
    expect(r.json()).toEqual([]);
  });

  it('info で Driver の対応を知らせる', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/info', headers: H });
    expect(r.json().agents.claude).toMatchObject({ attachments: true, commands: true });
    expect(r.json().agents.codex).toMatchObject({ attachments: false, commands: false });
  });
});
