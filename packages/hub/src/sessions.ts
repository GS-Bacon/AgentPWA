// セッション管理: Driver の起動・停止・再開、イベントの採番・保存・配信。
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentDriver, AgentKind, AuthCheck, DriverEvent, DriverSession, SessionEvent, UserAction } from '@agentpwa/shared';
import type { CreateSessionRequest, SessionSummary, UsageInfo } from './api.ts';
import { findAllowedFolder, type HubConfig } from './config.ts';
import type { Store } from './db.ts';
import { applyEvent, markRead, newRecord, recoverAfterRestart, sortRecords, titleFromPrompt, toSummary, type SessionRecord } from './state.ts';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const AUTH_CACHE_MS = 60_000;

export interface SessionManagerEvents {
  session: [SessionSummary];
  event: [SessionEvent];
  usage: [AgentKind, UsageInfo[]];
  config: [];
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private records = new Map<string, SessionRecord>();
  private live = new Map<string, DriverSession>();
  private starting = new Map<string, Promise<DriverSession>>();
  private usage = new Map<AgentKind, Map<string, UsageInfo>>();
  private authCache = new Map<AgentKind, { at: number; value: AuthCheck }>();
  private shuttingDown = false;

  constructor(
    private readonly store: Store,
    private readonly drivers: Map<AgentKind, AgentDriver>,
    private readonly config: HubConfig,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    super();
  }

  /** 保存済みのセッションを読み込み、前回の Hub で作業中だったものを stopped にする。 */
  init(): void {
    for (const rec of this.store.loadSessions()) {
      rec.lastSeq = Math.max(rec.lastSeq, this.store.maxSeq(rec.id));
      this.records.set(rec.id, rec);
      const fix = recoverAfterRestart(rec);
      if (fix) this.record(rec.id, { type: 'status', status: fix.status, reason: fix.reason });
    }
  }

  // ---- 参照 ----

  list(): SessionSummary[] {
    return sortRecords([...this.records.values()]).map((r) => this.summary(r));
  }

  get(id: string): SessionSummary {
    return this.summary(this.mustGet(id));
  }

  events(id: string, afterSeq: number): SessionEvent[] {
    this.mustGet(id);
    return this.store.eventsAfter(id, afterSeq);
  }

  usageOf(agent: AgentKind): UsageInfo[] {
    return [...(this.usage.get(agent)?.values() ?? [])];
  }

  async checkAuth(agent: AgentKind, force = false): Promise<AuthCheck> {
    const driver = this.drivers.get(agent);
    if (!driver) return { ok: false, auth: 'unknown', detail: `${agent} の Driver がありません` };
    const cached = this.authCache.get(agent);
    if (!force && cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.value;
    let value: AuthCheck;
    try {
      value = await driver.checkAuth();
    } catch (e) {
      value = { ok: false, auth: 'unknown', detail: (e as Error).message };
    }
    this.authCache.set(agent, { at: Date.now(), value });
    return value;
  }

  /** 設定ファイルが読み直されたことを Web に知らせる */
  notifyConfigChanged(): void {
    this.authCache.clear();
    this.emit('config');
  }

  // ---- 操作 ----

  async create(req: CreateSessionRequest): Promise<SessionSummary> {
    const folder = findAllowedFolder(this.config, req.cwd);
    if (!folder) throw new HttpError(403, 'このフォルダは許可リストに入っていません');
    // AI はプロジェクト（作業フォルダ）ごとに設定ファイルで決めてある
    const agent = folder.agent;
    if (req.agent && req.agent !== agent) throw new HttpError(400, `このプロジェクトは ${agent} 用です`);
    const driver = this.drivers.get(agent);
    if (!driver) throw new HttpError(400, `${agent} の Driver がありません`);
    const auth = await this.checkAuth(agent, true);
    if (!auth.ok || auth.auth === 'api_key') {
      throw new HttpError(409, auth.detail ?? '認証を確認できないため起動しません');
    }
    const now = this.now();
    const rec = newRecord({
      id: randomUUID(),
      agent,
      title: req.title?.trim() || titleFromPrompt(req.prompt),
      cwd: folder.path,
      folderName: folder.name,
      model: req.model || undefined,
      permissionMode: req.permissionMode ?? 'ask',
      now,
    });
    this.records.set(rec.id, rec);
    this.store.saveSession(rec);
    this.emit('session', this.summary(rec));
    await this.startDriver(rec.id, req.prompt?.trim() || undefined);
    return this.get(rec.id);
  }

  /** 止まっているセッションを再開する（resume_token があれば続きから）。 */
  async resume(id: string): Promise<SessionSummary> {
    this.mustGet(id);
    await this.ensureLive(id);
    return this.get(id);
  }

  async stop(id: string): Promise<SessionSummary> {
    const rec = this.mustGet(id);
    const s = this.live.get(id);
    if (s) {
      await s.stop();
      this.live.delete(id);
    } else if (rec.status !== 'stopped') {
      this.record(id, { type: 'status', status: 'stopped' });
    }
    return this.get(id);
  }

  async action(id: string, action: UserAction): Promise<void> {
    this.mustGet(id);
    let s = this.live.get(id);
    if (!s) {
      if (action.type === 'interrupt') return;
      if (action.type !== 'send') throw new HttpError(409, 'セッションが動いていません。再開してから操作してください');
      s = await this.ensureLive(id);
    }
    try {
      await s.send(action);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  read(id: string, seq?: number): SessionSummary {
    const rec = this.mustGet(id);
    const next = markRead(rec, seq);
    if (next !== rec) {
      this.records.set(id, next);
      this.store.saveSession(next);
      this.emit('session', this.summary(next));
    }
    return this.summary(next);
  }

  update(id: string, patch: { title?: string; archived?: boolean }): SessionSummary {
    const rec = this.mustGet(id);
    const next: SessionRecord = { ...rec };
    if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim().slice(0, 100);
    if (typeof patch.archived === 'boolean') next.archived = patch.archived;
    this.records.set(id, next);
    this.store.saveSession(next);
    const sum = this.summary(next);
    this.emit('session', sum);
    return sum;
  }

  /** Hub の終了時: 子プロセスを止める。状態は書き換えない（次の起動時に recoverAfterRestart が整える）。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.live.values()].map((s) => s.stop()));
    this.live.clear();
  }

  // ---- 内部 ----

  private mustGet(id: string): SessionRecord {
    const rec = this.records.get(id);
    if (!rec) throw new HttpError(404, 'セッションが見つかりません');
    return rec;
  }

  private summary(rec: SessionRecord): SessionSummary {
    return toSummary(rec, { machine: this.config.machineName, live: this.live.has(rec.id) });
  }

  private async ensureLive(id: string): Promise<DriverSession> {
    const s = this.live.get(id);
    if (s) return s;
    const pending = this.starting.get(id);
    if (pending) return pending;
    return this.startDriver(id, undefined);
  }

  private startDriver(id: string, initialPrompt: string | undefined): Promise<DriverSession> {
    const rec = this.mustGet(id);
    const driver = this.drivers.get(rec.agent);
    if (!driver) throw new HttpError(400, `${rec.agent} の Driver がありません`);
    const p = (async () => {
      if (rec.lastSeq > 0) {
        const auth = await this.checkAuth(rec.agent);
        if (!auth.ok || auth.auth === 'api_key') throw new HttpError(409, auth.detail ?? '認証を確認できないため起動しません');
      }
      try {
        const session = await driver.start(
          {
            sessionId: id,
            cwd: rec.cwd,
            model: rec.model,
            permissionMode: rec.permissionMode,
            initialPrompt,
            resumeToken: rec.resumeToken,
          },
          (ev) => this.onDriverEvent(id, ev),
        );
        this.live.set(id, session);
        return session;
      } catch (e) {
        this.record(id, { type: 'error', message: `起動できませんでした: ${(e as Error).message}`, fatal: true });
        this.record(id, { type: 'status', status: 'error' });
        throw new HttpError(500, (e as Error).message);
      }
    })();
    this.starting.set(id, p);
    p.finally(() => this.starting.delete(id)).catch(() => {});
    return p;
  }

  private onDriverEvent(id: string, ev: DriverEvent): void {
    if (this.shuttingDown) return;
    if (ev.type === 'status' && ev.status === 'stopped') this.live.delete(id);
    if (ev.type === 'usage') {
      const rec = this.records.get(id);
      if (rec) {
        const m = this.usage.get(rec.agent) ?? new Map<string, UsageInfo>();
        m.set(ev.label, ev);
        this.usage.set(rec.agent, m);
        this.emit('usage', rec.agent, [...m.values()]);
      }
    }
    this.record(id, ev);
  }

  /** イベントに seq と時刻を付けて保存・適用・配信する。 */
  private record(id: string, ev: DriverEvent): void {
    const rec = this.records.get(id);
    if (!rec) return;
    const full = { ...ev, sessionId: id, seq: rec.lastSeq + 1, at: this.now() } as SessionEvent;
    const next = applyEvent(rec, full);
    this.records.set(id, next);
    this.store.insertEvent(full);
    // 断片はセッション本体の保存を省く（再起動時は events の最大 seq から lastSeq を戻す）
    if (ev.type !== 'message_delta') this.store.saveSession(next);
    this.emit('event', full);
    if (ev.type !== 'message_delta' || rec.status !== next.status) this.emit('session', this.summary(next));
  }
}
