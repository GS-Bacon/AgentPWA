// セッション管理: Driver の起動・停止・再開、イベントの採番・保存・配信。
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { EFFORT_LEVELS, PERMISSION_MODES, type AgentDriver, type AgentKind, type AuthCheck, type DriverEvent, type DriverSession, type PermissionMode, type SessionEvent, type UserAction } from '@agentpwa/shared';
import type { CreateSessionRequest, DeleteSessionResult, SessionSummary, UpdateSessionRequest, UsageInfo } from './api.ts';
import { findAllowedFolder, isModeAllowed, type HubConfig } from './config.ts';
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

const MODEL_INVALID = 'モデル名が正しくありません（英数字と . _ - : [ ] だけ、100文字まで）';

/** モデル名（エイリアスか正式名）。CLI の引数に渡すので、使える文字を絞る */
function isModelName(v: string): boolean {
  return /^[A-Za-z0-9._:[\]-]{1,100}$/.test(v);
}

const FULL_AUTO_DENIED ='「すべて自動」は、このプロジェクトでは許可されていません（設定ファイルの folders で allowFullAuto: true にしたプロジェクトだけで使えます）';

export interface SessionManagerEvents {
  session: [SessionSummary];
  /** セッションを削除した */
  removed: [string];
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
    // full_auto の許可を外されたプロジェクトで動いているセッションは「毎回確認」に戻す
    for (const [id, s] of this.live) {
      const rec = this.records.get(id);
      if (rec && !isModeAllowed(this.config, rec.cwd, rec.permissionMode)) {
        s.send({ type: 'set_permission_mode', mode: 'ask' }).catch(() => {});
      }
    }
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
    const permissionMode = req.permissionMode ?? folder.defaultPermissionMode ?? 'ask';
    if (!PERMISSION_MODES.includes(permissionMode)) throw new HttpError(400, '権限モードが正しくありません');
    if (!isModeAllowed(this.config, folder.path, permissionMode)) throw new HttpError(403, FULL_AUTO_DENIED);
    const model = req.model?.trim() || undefined;
    if (model !== undefined && !isModelName(model)) throw new HttpError(400, MODEL_INVALID);
    if (req.effort !== undefined && !EFFORT_LEVELS.includes(req.effort)) throw new HttpError(400, 'エフォートが正しくありません');
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
      model,
      effort: req.effort,
      permissionMode,
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
    const rec = this.mustGet(id);
    if (rec.archived) throw new HttpError(409, 'アーカイブ済みのセッションです。アーカイブを解除してから再開してください');
    await this.ensureLive(id);
    return this.get(id);
  }

  async stop(id: string): Promise<SessionSummary> {
    this.mustGet(id);
    await this.halt(id);
    return this.get(id);
  }

  async action(id: string, action: UserAction): Promise<void> {
    const rec = this.mustGet(id);
    if (action.type === 'set_permission_mode') return this.setPermissionMode(id, action.mode);
    if (action.type === 'set_model') return this.setModel(id, action);
    let s = this.live.get(id);
    if (!s) {
      if (action.type === 'interrupt') return;
      if (action.type !== 'send') throw new HttpError(409, 'セッションが動いていません。再開してから操作してください');
      if (rec.archived) throw new HttpError(409, 'アーカイブ済みのセッションです。アーカイブを解除してから送信してください');
      s = await this.ensureLive(id);
    }
    try {
      await s.send(action);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  /**
   * 権限モードを切り替える。full_auto は許可したプロジェクトだけで、それ以外は Driver に渡さずに拒否する。
   * 動いていないセッションは Hub が覚えておき、次に起動・再開するときに渡す。
   */
  private async setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    const rec = this.mustGet(id);
    if (!PERMISSION_MODES.includes(mode)) throw new HttpError(400, '権限モードが正しくありません');
    if (!isModeAllowed(this.config, rec.cwd, mode)) throw new HttpError(403, FULL_AUTO_DENIED);
    let s = this.live.get(id);
    if (!s) {
      const pending = this.starting.get(id);
      if (pending) s = await pending.catch(() => undefined);
    }
    if (!s) {
      if (rec.permissionMode !== mode) this.record(id, { type: 'permission_mode', mode });
      return;
    }
    try {
      // 反映できたら Driver が permission_mode を送る。できなければ error（fatal: false）が届き、モードは変わらない
      await s.send({ type: 'set_permission_mode', mode });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  /**
   * モデルとエフォートを切り替える（省略は変えない、null は既定に戻す）。
   * 動いていないセッションは Hub が覚えておき、次に起動・再開するときに渡す。
   */
  private async setModel(id: string, action: Extract<UserAction, { type: 'set_model' }>): Promise<void> {
    const rec = this.mustGet(id);
    const a: Extract<UserAction, { type: 'set_model' }> = { type: 'set_model' };
    if (action.model !== undefined) {
      const m = action.model?.trim() || null;
      if (m !== null && !isModelName(m)) throw new HttpError(400, MODEL_INVALID);
      a.model = m;
    }
    if (action.effort !== undefined) {
      if (action.effort !== null && !EFFORT_LEVELS.includes(action.effort)) throw new HttpError(400, 'エフォートが正しくありません');
      a.effort = action.effort;
    }
    let s = this.live.get(id);
    if (!s) {
      const pending = this.starting.get(id);
      if (pending) s = await pending.catch(() => undefined);
    }
    if (!s) {
      const model = a.model === undefined ? rec.model : a.model ?? undefined;
      const effort = a.effort === undefined ? rec.effort : a.effort ?? undefined;
      const ev: DriverEvent = { type: 'model' };
      if (model) ev.model = model;
      if (effort) ev.effort = effort;
      // 設定が変わらなければ、解決済みの値はそのまま使える（変わったら次の起動で Driver が調べ直す）
      if (model === rec.model && effort === rec.effort) {
        if (rec.resolvedModel) ev.resolvedModel = rec.resolvedModel;
        if (rec.resolvedEffort) ev.resolvedEffort = rec.resolvedEffort;
      }
      this.record(id, ev);
      return;
    }
    try {
      // 反映できたら Driver が model を送る。できなければ error（fatal: false）が届き、設定は変わらない
      await s.send(a);
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

  /**
   * 名前の変更とアーカイブ・解除。
   * アーカイブするときは、動いているセッション（stopped 以外）を先に止める。解除しても stopped のままで、
   * 次に送信したときに resume_token で再開する。
   */
  async update(id: string, patch: UpdateSessionRequest): Promise<SessionSummary> {
    const first = this.mustGet(id);
    if (patch.archived === true && !first.archived) await this.halt(id);
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

  /**
   * セッションを1件削除する（元に戻せない。一括削除は作らない）。
   * 動いていれば止め、Hub の記録（セッションとイベント）を消してから、Driver が対応していればエージェント側の履歴も消す。
   * エージェント側の削除に失敗しても Hub 側の削除は取り消さず、理由を historyError で返す。
   */
  async remove(id: string): Promise<DeleteSessionResult> {
    this.mustGet(id);
    await this.halt(id);
    const rec = this.mustGet(id);
    this.records.delete(id);
    this.live.delete(id);
    this.store.deleteSession(id);
    this.emit('removed', id);
    const driver = this.drivers.get(rec.agent);
    if (driver?.deleteHistory && rec.resumeToken) {
      try {
        await driver.deleteHistory({ cwd: rec.cwd, resumeToken: rec.resumeToken });
      } catch (e) {
        return { ok: true, historyError: (e as Error).message || String(e) };
      }
    }
    return { ok: true };
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

  /** 起動中なら起動を待ってから、動いているセッションを止める。終わったら必ず stopped にする。 */
  private async halt(id: string): Promise<void> {
    const pending = this.starting.get(id);
    if (pending) await pending.catch(() => {});
    const s = this.live.get(id);
    if (s) {
      try {
        await s.stop();
      } finally {
        this.live.delete(id);
      }
    }
    const rec = this.records.get(id);
    if (rec && rec.status !== 'stopped') this.record(id, { type: 'status', status: 'stopped' });
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
      // 設定の変更で full_auto の許可が外れたプロジェクトでは、Driver に full_auto を渡さない
      let permissionMode = rec.permissionMode;
      if (!isModeAllowed(this.config, rec.cwd, permissionMode)) {
        permissionMode = 'ask';
        this.record(id, { type: 'error', message: '「すべて自動」はこのプロジェクトで許可されていないため、「毎回確認」で起動します', fatal: false });
        this.record(id, { type: 'permission_mode', mode: permissionMode });
      }
      try {
        const session = await driver.start(
          {
            sessionId: id,
            cwd: rec.cwd,
            model: rec.model,
            effort: rec.effort,
            permissionMode,
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
