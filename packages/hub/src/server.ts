// HTTP / WebSocket サーバー（Fastify）。
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { PERMISSION_MODES, PROTOCOL_VERSION, type AgentKind, type PermissionMode, type SessionEvent, type UserAction } from '@agentpwa/shared';
import type { CreateProjectRequest, CreateSessionRequest, HubInfo, ServerMessage, SessionSummary, UpdateSessionRequest, UsageInfo } from './api.ts';
import { checkRequest } from './auth.ts';
import type { HubConfig } from './config.ts';
import { createProject, listDirs, type ProjectDeps } from './projects.ts';
import { HttpError, type SessionManager } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    tailscaleUser?: string;
  }
}

export interface ServerOptions {
  manager: SessionManager;
  config: HubConfig;
  configPath: string;
  /** ビルド済みの Web（packages/web/dist）。あれば静的に配信する */
  webDist?: string;
  /** 'fake' にした agent */
  fakeAgents: AgentKind[];
  logger?: boolean;
}

const AGENTS: AgentKind[] = ['claude', 'codex'];

function isMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

function parseAction(body: unknown): UserAction {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.type) {
    case 'send':
      if (typeof b.text !== 'string' || !b.text.trim()) break;
      return { type: 'send', text: b.text };
    case 'approve':
      if (typeof b.requestId !== 'string' || !['allow', 'allow_session', 'deny'].includes(String(b.decision))) break;
      return { type: 'approve', requestId: b.requestId, decision: b.decision as 'allow' | 'allow_session' | 'deny', note: typeof b.note === 'string' ? b.note : undefined };
    case 'answer':
      if (typeof b.requestId !== 'string' || typeof b.text !== 'string') break;
      return { type: 'answer', requestId: b.requestId, text: b.text };
    case 'interrupt':
      return { type: 'interrupt' };
    case 'set_permission_mode':
      if (!isMode(b.mode)) break;
      return { type: 'set_permission_mode', mode: b.mode };
  }
  throw new HttpError(400, '操作の形が正しくありません');
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { manager, config } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });

  // すべてのリクエスト（静的ファイルと WebSocket を含む）で利用者を確認する
  app.addHook('onRequest', async (req, reply) => {
    const r = checkRequest(req.headers, config);
    if (!r.ok) {
      reply.code(r.status).type('text/plain; charset=utf-8').send(r.reason);
      return reply;
    }
    req.tailscaleUser = r.user;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: (err as Error).message });
  });

  async function info(req: FastifyRequest): Promise<HubInfo> {
    const auths = await Promise.all(AGENTS.map((a) => manager.checkAuth(a)));
    return {
      machine: config.machineName,
      user: req.tailscaleUser,
      folders: config.folders,
      agents: Object.fromEntries(AGENTS.map((a, i) => [a, { auth: auths[i], fake: opts.fakeAgents.includes(a) }])) as HubInfo['agents'],
      usage: Object.fromEntries(AGENTS.map((a) => [a, manager.usageOf(a)])) as HubInfo['usage'],
      configPath: opts.configPath,
      protocolVersion: PROTOCOL_VERSION,
      projectRoots: config.projectRoots,
    };
  }

  const projectDeps: ProjectDeps = {
    config,
    configPath: opts.configPath,
    agentAvailable: async (a) => (await manager.checkAuth(a)).ok,
    onChanged: () => manager.notifyConfigChanged(),
  };

  await app.register(fastifyWebsocket);

  app.get('/api/info', async (req) => info(req));
  app.get('/api/sessions', async () => manager.list());

  // プロジェクトの作成（ルートフォルダ projectRoots の下だけ。作ったものは設定ファイルの folders に書き足す）
  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (req) => listDirs(config, req.query.path || undefined));
  app.post('/api/projects', async (req) => createProject(projectDeps, (req.body ?? {}) as Partial<CreateProjectRequest>));

  app.post('/api/sessions', async (req) => {
    const b = (req.body ?? {}) as Partial<CreateSessionRequest>;
    if (b.agent !== undefined && !AGENTS.includes(b.agent)) throw new HttpError(400, 'agent が正しくありません');
    if (typeof b.cwd !== 'string') throw new HttpError(400, 'フォルダを指定してください');
    // 省略時はプロジェクトの既定のモード。full_auto の可否は SessionManager が確かめる
    if (b.permissionMode !== undefined && !isMode(b.permissionMode)) throw new HttpError(400, '権限モードが正しくありません');
    return manager.create({
      agent: b.agent,
      cwd: b.cwd,
      model: typeof b.model === 'string' ? b.model : undefined,
      permissionMode: b.permissionMode,
      prompt: typeof b.prompt === 'string' ? b.prompt : undefined,
      title: typeof b.title === 'string' ? b.title : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => manager.get(req.params.id));

  // 名前の変更とアーカイブ・解除（アーカイブするときは、動いているセッションを先に止める）
  app.patch<{ Params: { id: string }; Body: UpdateSessionRequest }>('/api/sessions/:id', async (req) => {
    const b = req.body ?? {};
    return manager.update(req.params.id, {
      title: typeof b.title === 'string' ? b.title : undefined,
      archived: typeof b.archived === 'boolean' ? b.archived : undefined,
    });
  });

  // 削除は1件ずつ（一括削除は作らない）。エージェント側の履歴を消せなかったときは historyError を返す
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => manager.remove(req.params.id));

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/sessions/:id/events', async (req) =>
    manager.events(req.params.id, Number(req.query.after ?? 0) || 0),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/resume', async (req) => manager.resume(req.params.id));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (req) => manager.stop(req.params.id));
  app.post<{ Params: { id: string }; Body: { seq?: number } }>('/api/sessions/:id/read', async (req) =>
    manager.read(req.params.id, typeof req.body?.seq === 'number' ? req.body.seq : undefined),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/action', async (req) => {
    await manager.action(req.params.id, parseAction(req.body));
    return { ok: true };
  });

  // WebSocket: 接続時に一覧を送り、以後はセッションの変化とイベントを流す。
  // 再接続した Web は、表示中のセッションについて /events?after=<最後の seq> で差分を取り直す。
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const onSession = (session: SessionSummary) => send({ type: 'session', session });
    const onRemoved = (sessionId: string) => send({ type: 'session_removed', sessionId });
    const onEvent = (event: SessionEvent) => send({ type: 'event', event });
    const onUsage = (agent: AgentKind, usage: UsageInfo[]) => send({ type: 'usage', agent, usage });
    const onConfig = () => void info(req).then((i) => send({ type: 'info', info: i }));
    manager.on('session', onSession);
    manager.on('removed', onRemoved);
    manager.on('event', onEvent);
    manager.on('usage', onUsage);
    manager.on('config', onConfig);
    const ping = setInterval(() => socket.ping(), 25_000);
    socket.on('close', () => {
      clearInterval(ping);
      manager.off('session', onSession);
      manager.off('removed', onRemoved);
      manager.off('event', onEvent);
      manager.off('usage', onUsage);
      manager.off('config', onConfig);
    });
    socket.on('message', () => {
      /* Web からの送信は REST で受ける */
    });
    send({ type: 'hello', sessions: manager.list(), info: await info(req) });
  });

  if (opts.webDist && fs.existsSync(path.join(opts.webDist, 'index.html'))) {
    // wildcard: true でリクエストのたびにファイルを探す。false だと起動時にあったファイルにしかルートができず、
    // Hub を動かしたまま Web をビルドし直すと新しい assets/*.js が index.html で返されて画面が真っ白になる。
    // 見つからないファイルは下の NotFound ハンドラーに回る。
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: true, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) {
        reply.type('text/html').sendFile('index.html');
        return;
      }
      reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
