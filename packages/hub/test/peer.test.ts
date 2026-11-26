// セッション間のメッセージ（v13）と、AI に伝える Hub の説明（StartOptions.hubGuide）の確認。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatPeerMessage, parsePeerMessage, type AgentDriver, type AgentKind, type DriverSession, type StartOptions, type UserAction } from '@agentpwa/shared';
import type { HubConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { buildHubGuide } from '../src/hub-guide.ts';
import { buildServer } from '../src/server.ts';
import { SessionManager } from '../src/sessions.ts';

/** 起動の引数と、受け取った操作を記録する Driver */
function recorder(kind: AgentKind) {
  const starts: StartOptions[] = [];
  const actions: { sessionId: string; action: UserAction }[] = [];
  const driver: AgentDriver = {
    kind,
    checkAuth: async () => ({ ok: true, auth: 'subscription' }),
    start: async (opts, emit): Promise<DriverSession> => {
      starts.push(opts);
      emit({ type: 'resume_token', token: `t-${opts.sessionId}` });
      emit({ type: 'status', status: 'idle' });
      return { send: async (action) => void actions.push({ sessionId: opts.sessionId, action }), stop: async () => {} };
    },
  };
  return { driver, starts, actions };
}

let dir: string;
let store: Store | undefined;
const prevUrl = process.env.AGENTPWA_HUB_URL;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-peer-'));
  process.env.AGENTPWA_HUB_URL = 'http://127.0.0.1:8787';
});

afterEach(() => {
  store?.close();
  store = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevUrl === undefined) delete process.env.AGENTPWA_HUB_URL;
  else process.env.AGENTPWA_HUB_URL = prevUrl;
});

async function setup() {
  const config = {
    port: 0,
    machineName: 'laptop',
    allowedUsers: ['me@example.com'],
    allowLocalhost: false,
    folders: [
      { name: 'cl', path: path.join(dir, 'p'), agent: 'claude' },
      { name: 'cx', path: path.join(dir, 'p'), agent: 'codex' },
    ],
    projectRoots: [],
    codex: 'fake',
    dataDir: dir,
  } as HubConfig;
  const claude = recorder('claude');
  const codex = recorder('codex');
  store = new Store(path.join(dir, 'hub.db'));
  const manager = new SessionManager(store, new Map([['claude', claude.driver], ['codex', codex.driver]]), config);
  manager.init();
  const a = await manager.create({ agent: 'claude', cwd: config.folders[0].path, permissionMode: 'ask', title: '設計' });
  const b = await manager.create({ agent: 'codex', cwd: config.folders[1].path, permissionMode: 'ask', title: '実装' });
  return { manager, config, claude, codex, a, b };
}

describe('セッション間のメッセージ', () => {
  it('送り元を書いた段落を先頭に付けて、相手の Driver に send で渡す', async () => {
    const { manager, codex, a, b } = await setup();
    await manager.action(b.id, { type: 'send', text: 'テストを足して' }, a.id);
    const sent = codex.actions.at(-1)!.action;
    expect(sent.type).toBe('send');
    const text = (sent as { text: string }).text;
    expect(text).toBe(formatPeerMessage({ sessionId: a.id, title: '設計', agent: 'claude' }, 'テストを足して'));
    expect(parsePeerMessage(text)).toEqual({ from: { sessionId: a.id, title: '設計', agent: 'claude' }, text: 'テストを足して' });
  });

  it('送り元が無い・自分宛て・send 以外は受け付けない', async () => {
    const { manager, a, b } = await setup();
    await expect(manager.action(b.id, { type: 'send', text: 'x' }, 'nope')).rejects.toThrow('送り元');
    await expect(manager.action(a.id, { type: 'send', text: 'x' }, a.id)).rejects.toThrow('自分');
    await expect(manager.action(b.id, { type: 'interrupt' }, a.id)).rejects.toThrow('send だけ');
  });

  it('HTTP: X-AgentPWA-Session 付きの action で届き、brief=1 で宛先を探せる', async () => {
    const { manager, config, claude, a, b } = await setup();
    const app = await buildServer({ manager, config, configPath: path.join(dir, 'config.json'), fakeAgents: [] });
    const H = { 'tailscale-user-login': 'me@example.com', host: 'laptop.example.ts.net' };
    try {
      const list = await app.inject({ method: 'GET', url: '/api/sessions?brief=1', headers: H });
      expect(list.json()).toEqual(
        expect.arrayContaining([{ id: b.id, title: '実装', agent: 'codex', project: 'cx', cwd: path.join(dir, 'p'), status: 'idle' }]),
      );
      const r = await app.inject({
        method: 'POST',
        url: `/api/sessions/${a.id}/action`,
        headers: { ...H, 'content-type': 'application/json', 'x-agentpwa-session': b.id },
        payload: JSON.stringify({ type: 'send', text: '終わりました' }),
      });
      expect(r.statusCode).toBe(200);
      expect(parsePeerMessage((claude.actions.at(-1)!.action as { text: string }).text)?.from).toEqual({ sessionId: b.id, title: '実装', agent: 'codex' });
    } finally {
      await app.close();
    }
  });

  it('題名に括弧や改行があっても分けられる。書式が違えば null', () => {
    const t = formatPeerMessage({ sessionId: 'abc-1', title: '「A」\n（B）', agent: 'codex' }, '本文\n\n2段落目');
    expect(parsePeerMessage(t)).toEqual({ from: { sessionId: 'abc-1', title: '「A」 （B）', agent: 'codex' }, text: '本文\n\n2段落目' });
    expect(parsePeerMessage('[AgentPWA] ただの文')).toBeNull();
  });
});

describe('Hub の説明（hubGuide）', () => {
  it('起動のたびに、セッション ID とエージェントに合わせた説明を渡す', async () => {
    const { claude, codex, a, b } = await setup();
    expect(claude.starts[0].hubGuide).toContain(`X-AgentPWA-Session: ${a.id}`);
    expect(claude.starts[0].hubGuide).toContain('curl -sS');
    expect(codex.starts[0].hubGuide).toContain(`'X-AgentPWA-Session' = '${b.id}'`);
    expect(codex.starts[0].hubGuide).toContain('Invoke-RestMethod');
  });

  it('Hub の URL が分からなければ何も渡さない', () => {
    expect(buildHubGuide(undefined, 's', 'claude')).toBeUndefined();
  });
});
