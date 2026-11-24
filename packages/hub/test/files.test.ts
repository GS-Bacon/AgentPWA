// ファイルビュワー用のファイル配信と、書き込み系 API の Origin の確認（docs/architecture.md の 5.1、6.7、7）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentDriver, DriverSession } from '@agentpwa/shared';
import { checkOrigin } from '../src/auth.ts';
import type { HubConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { SessionManager } from '../src/sessions.ts';

/** 起動しても何も送らない Driver（ファイル配信の確認にはセッションがあればよい） */
const silentDriver: AgentDriver = {
  kind: 'claude',
  checkAuth: async () => ({ ok: true, auth: 'subscription' }),
  start: async (): Promise<DriverSession> => ({ send: async () => {}, stop: async () => {} }),
};

let dir: string;
let proj: string;
let store: Store;
let app: FastifyInstance;
let sid: string;

const HOST = 'laptop.example.ts.net';
const H = { 'tailscale-user-login': 'me@example.com', host: HOST };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-files-'));
  proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'slides', 'img'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'slides', 'index.html'), '<html><img src="img/a.png"></html>');
  fs.writeFileSync(path.join(proj, 'slides', 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(proj, 'README.md'), '# 見出し');
  fs.writeFileSync(path.join(proj, 'スライド 1.txt'), 'あいう');
  fs.writeFileSync(path.join(proj, 'doc.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(proj, 'video.mp4'), Buffer.alloc(100, 7));
  fs.writeFileSync(path.join(proj, 'noext'), 'plain text');
  fs.writeFileSync(path.join(proj, 'blob.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
  const drive = path.join(dir, 'drive');
  fs.mkdirSync(path.join(drive, 'マイドライブ', 'cup', 'img'), { recursive: true });
  fs.writeFileSync(path.join(drive, 'マイドライブ', 'cup', 'concept.html'), '<html><img src="img/a.png"></html>');
  fs.writeFileSync(path.join(drive, 'マイドライブ', 'cup', 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const config: HubConfig = {
    viewerRoots: [drive],
    port: 0,
    machineName: 'laptop',
    allowedUsers: ['me@example.com'],
    allowLocalhost: false,
    folders: [{ name: 'proj', path: proj, agent: 'claude' }],
    projectRoots: [],
    codex: 'fake',
    dataDir: dir,
  } as HubConfig;
  store = new Store(path.join(dir, 'hub.db'));
  const manager = new SessionManager(store, new Map([['claude', silentDriver]]), config);
  manager.init();
  sid = (await manager.create({ agent: 'claude', cwd: proj, permissionMode: 'ask' })).id;
  app = await buildServer({ manager, config, configPath: path.join(dir, 'config.json'), fakeAgents: ['claude'] });
});

afterEach(async () => {
  await app.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { ...H, ...headers } });

describe('ファイルの配信', () => {
  it('file-info は相対パスと絶対パスのどちらでも、相対パスと種類を返す', async () => {
    const a = await get(`/api/sessions/${sid}/file-info?path=${encodeURIComponent('slides/index.html')}`);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ path: 'slides/index.html', kind: 'html' });
    const b = await get(`/api/sessions/${sid}/file-info?path=${encodeURIComponent(path.join(proj, 'README.md'))}`);
    expect(b.json()).toMatchObject({ path: 'README.md', kind: 'markdown' });
    expect((await get(`/api/sessions/${sid}/file-info?path=doc.pdf`)).json().kind).toBe('pdf');
    expect((await get(`/api/sessions/${sid}/file-info?path=video.mp4`)).json().kind).toBe('media');
    expect((await get(`/api/sessions/${sid}/file-info?path=noext`)).json().kind).toBe('text');
    expect((await get(`/api/sessions/${sid}/file-info?path=blob.bin`)).json().kind).toBe('binary');
  });

  it('プロジェクトの外、無いファイル、フォルダは開けない', async () => {
    expect((await get(`/api/sessions/${sid}/file-info?path=${encodeURIComponent('../secret.txt')}`)).statusCode).toBe(403);
    expect((await get(`/api/sessions/${sid}/file-info?path=${encodeURIComponent(path.join(dir, 'secret.txt'))}`)).statusCode).toBe(403);
    expect((await get(`/files/${sid}/..%2Fsecret.txt`)).statusCode).toBe(403);
    expect((await get(`/api/sessions/${sid}/file-info?path=nothing.txt`)).statusCode).toBe(404);
    expect((await get(`/api/sessions/${sid}/file-info?path=slides`)).statusCode).toBe(400);
    expect((await get(`/api/sessions/no-such-session/file-info?path=README.md`)).statusCode).toBe(404);
  });

  it('viewerRoots（Google ドライブなど）の下なら、プロジェクトの外でも絶対パスで開ける', async () => {
    const abs = path.join(dir, 'drive', 'マイドライブ', 'cup', 'concept.html');
    const info = (await get(`/api/sessions/${sid}/file-info?path=${encodeURIComponent(abs)}`)).json();
    expect(info.path).toBe(fs.realpathSync(abs).split(path.sep).join('/'));
    expect(info.kind).toBe('html');
    // Web と同じ組み立て方の URL で、HTML から相対パスの画像も読める
    const url = (rel: string) => `/files/${sid}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    expect((await get(url(info.path))).body).toContain('img/a.png');
    expect((await get(url(info.path.replace(/concept\.html$/, 'img/a.png')))).statusCode).toBe(200);
    // viewerRoots の外は今までどおり開けない
    expect((await get(`/api/sessions/${sid}/file-info?path=${encodeURIComponent(path.join(dir, 'secret.txt'))}`)).statusCode).toBe(403);
    expect((await get(url(info.path.replace(/drive\/マイドライブ\/cup\/concept\.html$/, 'secret.txt')))).statusCode).toBe(403);
  });

  it('シンボリックリンクでプロジェクトの外を指すファイルは開けない', async (ctx) => {
    try {
      fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(proj, 'link.txt'), 'file');
    } catch {
      ctx.skip(); // Windows でシンボリックリンクを作る権限が無い場合
      return;
    }
    expect((await get(`/files/${sid}/link.txt`)).statusCode).toBe(403);
  });

  it('/files/ はパスで指定でき、HTML にはサンドボックスの CSP を付ける', async () => {
    const r = await get(`/files/${sid}/slides/index.html`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-security-policy']).toBe('sandbox allow-scripts allow-popups');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('img/a.png');
    const img = await get(`/files/${sid}/slides/img/a.png`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.length).toBe(8);
  });

  it('日本語や空白を含むファイル名も開ける', async () => {
    const r = await get(`/files/${sid}/${encodeURIComponent('スライド 1.txt')}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('あいう');
  });

  it('PDF にはサンドボックスの CSP を付けない（ブラウザ内蔵の PDF 表示が動かなくなるため）', async () => {
    const r = await get(`/files/${sid}/doc.pdf`);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-security-policy']).toBeUndefined();
  });

  it('Range で一部だけ返す（Safari の動画再生用）', async () => {
    const r = await get(`/files/${sid}/video.mp4`, { range: 'bytes=10-19' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 10-19/100');
    expect(r.rawPayload.length).toBe(10);
    const tail = await get(`/files/${sid}/video.mp4`, { range: 'bytes=-5' });
    expect(tail.headers['content-range']).toBe('bytes 95-99/100');
    expect((await get(`/files/${sid}/video.mp4`, { range: 'bytes=200-' })).statusCode).toBe(416);
  });
});

describe('Origin の確認', () => {
  it('書き込み系の API は、別のオリジンと null を拒否し、同じオリジンと Origin なしは通す', async () => {
    const post = (origin?: string) =>
      app.inject({ method: 'POST', url: `/api/sessions/${sid}/read`, headers: { ...H, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, payload: { seq: 0 } });
    expect((await post(`https://${HOST}`)).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    expect((await post('null')).statusCode).toBe(403);
    expect((await post('https://evil.example.com')).statusCode).toBe(403);
  });

  it('GET は Origin を問わない（読み取りは CORS で守られる）', async () => {
    expect((await get('/api/sessions', { origin: 'null' })).statusCode).toBe(200);
  });

  it('text/plain の本文は受け付けない', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${sid}/action`, headers: { ...H, 'content-type': 'text/plain' }, payload: '{"type":"interrupt"}' });
    expect(r.statusCode).toBe(415);
  });

  it('WebSocket も同じ規則', () => {
    expect(checkOrigin('GET', '/ws', { host: HOST, origin: 'null' }).ok).toBe(false);
    expect(checkOrigin('GET', '/ws', { host: HOST, origin: `https://${HOST}` }).ok).toBe(true);
    expect(checkOrigin('GET', '/files/x/a.html', { host: HOST, origin: 'null' }).ok).toBe(true);
    expect(checkOrigin('DELETE', '/api/sessions/x', { host: HOST, origin: 'https://evil.example.com' }).ok).toBe(false);
  });
});

describe('AI からのセッション作成と空のセッション（HTTP）', () => {
  const postJson = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { ...H, 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });

  it('X-AgentPWA-Session を付けると cwd を省けて、作成元が記録される', async () => {
    const r = await postJson('/api/sessions', { prompt: '別の作業' }, { 'x-agentpwa-session': sid });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ parentSessionId: sid, cwd: proj, empty: false });
    // 作成元なしで cwd を省くと 400
    expect((await postJson('/api/sessions', { prompt: 'x' })).statusCode).toBe(400);
  });

  it('discard は空のセッションだけを消す', async () => {
    const full = (await postJson('/api/sessions', { cwd: proj, prompt: 'hi' })).json() as { id: string };
    expect((await postJson(`/api/sessions/${full.id}/discard`, {})).json()).toEqual({ removed: false });
    expect((await postJson(`/api/sessions/${sid}/discard`, {})).json()).toEqual({ removed: true });
    expect((await get(`/api/sessions/${sid}`)).statusCode).toBe(404);
  });
});
