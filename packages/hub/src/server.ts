// HTTP / WebSocket サーバー（Fastify）。
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { EFFORT_LEVELS, PERMISSION_MODES, PROTOCOL_VERSION, type AgentKind, type Attachment, type EffortLevel, type PermissionMode, type SessionEvent, type SlashCommand, type UserAction } from '@agentpwa/shared';
import type { CreateProjectRequest, ReorderProjectsRequest, CreateSessionRequest, FileInfo, HubInfo, ServerMessage, SessionSummary, UpdateSessionRequest, UsageInfo } from './api.ts';
import { checkOrigin, checkRequest } from './auth.ts';
import type { HubConfig } from './config.ts';
import { fileHeaders, resolveProjectFile, toInfo } from './files.ts';
import { createProject, listDirs, reorderProjects, type ProjectDeps } from './projects.ts';
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

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** 添付ファイルの上限（1回の送信あたり） */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 送信の本文の上限（添付ファイルの base64 を含む） */
const ACTION_BODY_LIMIT = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1_000_000;

function parseAttachments(v: unknown): Attachment[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) throw new HttpError(400, `添付できるファイルは ${MAX_ATTACHMENTS} 件までです`);
  let total = 0;
  const out: Attachment[] = [];
  for (const a of v as Record<string, unknown>[]) {
    if (typeof a?.name !== 'string' || !a.name.trim() || a.name.length > 255) throw new HttpError(400, '添付ファイルの名前が正しくありません');
    if (typeof a.mimeType !== 'string' || a.mimeType.length > 200) throw new HttpError(400, '添付ファイルの種類が正しくありません');
    if (typeof a.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new HttpError(400, '添付ファイルの中身が正しくありません');
    total += Math.floor((a.data.length * 3) / 4);
    out.push({ name: a.name.trim(), mimeType: a.mimeType || 'application/octet-stream', data: a.data });
  }
  if (total > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `添付ファイルは合計 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB までです`);
  return out.length > 0 ? out : undefined;
}

function parseAction(body: unknown): UserAction {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.type) {
    case 'send': {
      if (typeof b.text !== 'string') break;
      const attachments = parseAttachments(b.attachments);
      if (!b.text.trim() && !attachments) break;
      return attachments ? { type: 'send', text: b.text, attachments } : { type: 'send', text: b.text };
    }
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
    case 'set_model': {
      // 省略は「変えない」、null は「既定に戻す」。形の確認だけここで行い、値の確認は SessionManager が行う
      if (b.model !== undefined && b.model !== null && typeof b.model !== 'string') break;
      if (b.effort !== undefined && b.effort !== null && !isEffort(b.effort)) break;
      if (b.model === undefined && b.effort === undefined) break;
      const a: UserAction = { type: 'set_model' };
      if (b.model !== undefined) a.model = b.model as string | null;
      if (b.effort !== undefined) a.effort = b.effort as EffortLevel | null;
      return a;
    }
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
    // 書き込み系の API と WebSocket は、PWA 自身のページからだけ受け付ける
    // （ファイルビュワーで開いた HTML の中のスクリプトなどから操作されないため。docs/architecture.md の 7）
    const o = checkOrigin(req.method, req.url, req.headers);
    if (!o.ok) {
      reply.code(403).type('text/plain; charset=utf-8').send(o.reason);
      return reply;
    }
  });

  // 本文のある API は JSON だけを受け付ける（text/plain の本文は、別のオリジンのフォームなどから送れてしまうため）
  app.removeContentTypeParser('text/plain');

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
      agents: Object.fromEntries(AGENTS.map((a, i) => [a, { auth: auths[i], fake: opts.fakeAgents.includes(a), ...manager.features(a) }])) as HubInfo['agents'],
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
  // プロジェクトの並び順（設定ファイルの folders の順）。登録済みのプロジェクトをすべて、新しい順で受け取る
  app.put('/api/projects/order', async (req) => reorderProjects(projectDeps, (req.body as Partial<ReorderProjectsRequest> | undefined)?.paths));

  app.post('/api/sessions', async (req) => {
    const b = (req.body ?? {}) as Partial<CreateSessionRequest>;
    // AI がセッションの中から作るときは、作成元のセッションを X-AgentPWA-Session で渡す（docs/architecture.md「AI からのセッション作成」）
    const parentHeader = req.headers['x-agentpwa-session'];
    const parent = (Array.isArray(parentHeader) ? parentHeader[0] : parentHeader)?.trim() || undefined;
    if (b.agent !== undefined && !AGENTS.includes(b.agent)) throw new HttpError(400, 'agent が正しくありません');
    if (typeof b.cwd !== 'string' && !(parent && b.cwd === undefined)) throw new HttpError(400, 'フォルダを指定してください');
    // 省略時はプロジェクトの既定のモード。full_auto の可否は SessionManager が確かめる
    if (b.permissionMode !== undefined && !isMode(b.permissionMode)) throw new HttpError(400, '権限モードが正しくありません');
    if (b.effort !== undefined && !isEffort(b.effort)) throw new HttpError(400, 'エフォートが正しくありません');
    return manager.create({
      agent: b.agent,
      cwd: b.cwd ?? '',
      model: typeof b.model === 'string' ? b.model : undefined,
      effort: b.effort,
      permissionMode: b.permissionMode,
      prompt: typeof b.prompt === 'string' ? b.prompt : undefined,
      title: typeof b.title === 'string' ? b.title : undefined,
    }, parent);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => manager.get(req.params.id));

  // 空のセッション（何も書き込まれていない）なら消す。Web がペインを閉じたとき・別のセッションに切り替えたときに呼ぶ
  app.post<{ Params: { id: string } }>('/api/sessions/:id/discard', async (req) => ({ removed: await manager.discardIfEmpty(req.params.id) }));

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
  // 添付ファイル（base64）を含められるよう、この API だけ本文の上限を上げる
  app.post<{ Params: { id: string } }>('/api/sessions/:id/action', { bodyLimit: ACTION_BODY_LIMIT }, async (req) => {
    await manager.action(req.params.id, parseAction(req.body));
    return { ok: true };
  });
  // 入力欄のスラッシュコマンドの補完
  app.get<{ Params: { id: string } }>('/api/sessions/:id/commands', async (req): Promise<SlashCommand[]> => manager.commands(req.params.id));

  // ファイルビュワー（docs/architecture.md の 5.1、6.7）。プロジェクトのフォルダの下のファイルだけ
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/file-info', async (req): Promise<FileInfo> => {
    const s = manager.get(req.params.id);
    return toInfo(await resolveProjectFile(s.cwd, req.query.path ?? ''));
  });

  // HTML の中の相対パス（img/a.png など）がそのまま解決できるように、クエリではなくパスで指定する
  app.get<{ Params: { id: string; '*': string } }>('/files/:id/*', async (req, reply) => {
    const s = manager.get(req.params.id);
    const f = await resolveProjectFile(s.cwd, req.params['*'] ?? '');
    reply.headers(fileHeaders(f));
    reply.header('accept-ranges', 'bytes');
    // iPhone / iPad の Safari は、動画を Range で読めないと再生しない
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && f.size > 0 && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : f.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : f.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, f.size - 1);
      if (start > end) {
        reply.code(416).header('content-range', `bytes */${f.size}`);
        return reply.send();
      }
      reply.code(206).header('content-range', `bytes ${start}-${end}/${f.size}`).header('content-length', end - start + 1);
      return reply.send(fs.createReadStream(f.real, { start, end }));
    }
    reply.header('content-length', f.size);
    return reply.send(fs.createReadStream(f.real));
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
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws') && !req.url.startsWith('/files/')) {
        reply.type('text/html').sendFile('index.html');
        return;
      }
      reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
