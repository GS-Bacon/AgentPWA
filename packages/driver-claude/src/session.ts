// 1つの Claude セッション（claude CLI の子プロセス）を管理する。
//
// - プロセスは送信が必要になったときに起動し、ターンが終わっても標準入力を開いたまま次の指示を待つ。
// - プロセスが無い状態で送信されたら、`--resume <session_id>` で起動し直してから送る（Hub 再起動後の再開も同じ）。
// - 子プロセスは起動役（ProcessLauncher）を通して起動する（local / ssh を Driver から切り離すため）。
// - 許可要求は `--permission-prompt-tool stdio` で、標準出力の control_request（can_use_tool）として受け、
//   Hub からの approve / answer で決めた結果を標準入力の control_response で返す。
//   MCP ツールは使わない（SSH 先の CLI から Hub 内の MCP サーバーに届かないため。docs/architecture.md の 6.4）。
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { EFFORT_LEVELS, type Attachment, type DriverEvent, type DriverSession, type EffortLevel, type PermissionMode, type SessionStatus, type StartOptions, type UserAction } from '@agentpwa/shared';
import { buildUserContent, type AttachmentStore } from './attachments.ts';
import { hubGuide, withHubEnv } from './hub-guide.ts';
import type { ProcessLauncher } from './launcher.ts';
import { StreamMapper } from './mapper.ts';
import { answerToUpdatedInput, buildPrompt, sessionAllowKey, toClaudePermissionMode } from './permissions.ts';
import { childEnv, probeControl } from './probe.ts';

/** 中断要求に CLI が応じないとき、プロセスを終了させるまでの待ち時間 */
const INTERRUPT_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 3000;
/** こちらから送った制御要求（権限モードの切り替えなど）の応答を待つ上限 */
const CONTROL_TIMEOUT_MS = 15_000;

/** claude CLI に返す許可の決定（can_use_tool への応答）。 */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface Pending {
  kind: 'approval' | 'question';
  /** CLI の control_request の request_id（応答に使う） */
  cliRequestId: string;
  toolName: string;
  input: Record<string, unknown>;
  allowKey: string;
}

interface OutgoingControl {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClaudeSessionDeps {
  launcher: ProcessLauncher;
  claudePath: string;
  env: NodeJS.ProcessEnv;
  /**
   * 既定のモデルとエフォートが実際に何になるかを調べて model イベントの resolvedModel / resolvedEffort に入れる。
   * プロセスが無いときは CLI を短く起動して聞く（API は呼ばない）。省略時は調べない（テスト用）
   */
  resolveDefaults?: boolean;
  /** 画像以外の添付ファイルの置き場所。省略時は画像だけ受け付ける */
  attachments?: AttachmentStore;
}

/** 既定やエイリアスを解決した、実際に使われるモデルとエフォート */
interface Resolved {
  model?: string;
  effort?: EffortLevel;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * Driver が自分で処理するスラッシュコマンド（引数つきの /model と /effort）。
 * 戻り値は setModel に渡す値（undefined は変えない、null は既定に戻す）。それ以外のコマンドは null（CLI に送る）。
 */
export function parseLocalCommand(text: string): { model?: string | null; effort?: EffortLevel | null } | null {
  const m = /^\/(model|effort)\s+(\S+)\s*$/.exec(text.trim());
  if (!m) return null;
  const arg = m[2];
  const reset = arg === 'default' || arg === 'auto';
  if (m[1] === 'model') {
    if (reset) return { model: null };
    return /^[A-Za-z0-9._:[\]-]{1,100}$/.test(arg) ? { model: arg } : null;
  }
  if (reset) return { effort: null };
  return EFFORT_LEVELS.includes(arg as EffortLevel) ? { effort: arg as EffortLevel } : null;
}

export class ClaudeSession implements DriverSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: SessionStatus = 'starting';
  /** プロトコルの requestId（= tool_use_id）→ 未解決の問い合わせ */
  private pending = new Map<string, Pending>();
  /** こちらから送った制御要求の request_id → 応答待ち */
  private outgoing = new Map<string, OutgoingControl>();
  private allowKeys = new Set<string>();
  private resumeToken: string | undefined;
  private mapper = new StreamMapper();
  /** いまの権限モード（次に起動するときの --permission-mode にも使う） */
  private mode: PermissionMode;
  private lastEmittedMode: PermissionMode | undefined;
  /** いまのモデルとエフォート（undefined は CLI の既定。次に起動するときの --model / --effort にも使う） */
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private resolved: Resolved = {};
  /** 調べ直しが重なったとき、古い結果で上書きしないための番号 */
  private resolveGen = 0;
  private stopping = false;
  private stopped = false;
  private interrupting = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  private killedOnPurpose = false;
  private stderrTail = '';
  private msgCounter = 0;
  private lastUsage = new Map<string, string>();

  constructor(
    private readonly opts: StartOptions,
    private readonly emit: (e: DriverEvent) => void,
    private readonly deps: ClaudeSessionDeps,
  ) {
    this.resumeToken = opts.resumeToken;
    this.mode = opts.permissionMode;
    this.model = opts.model || undefined;
    this.effort = opts.effort;
  }

  async init(): Promise<void> {
    this.emitMode(this.mode);
    this.emitModel();
    void this.refreshResolved();
    if (this.opts.initialPrompt) {
      this.sendText(this.opts.initialPrompt);
    } else {
      this.setStatus('idle');
    }
  }

  // ---- Hub からの操作 ----

  async send(action: UserAction): Promise<void> {
    if (this.stopped) throw new Error('セッションは終了しています');
    switch (action.type) {
      case 'send': {
        const local = action.attachments?.length ? null : parseLocalCommand(action.text);
        if (local) {
          // /model と /effort は、Web の切り替えと同じ扱いにする（CLI に任せると Hub と Web の表示がずれるため）
          this.emit({ type: 'message', messageId: `u-${Date.now().toString(36)}-${this.msgCounter++}`, role: 'user', text: action.text.trim() });
          await this.setModel(local.model, local.effort);
          return;
        }
        this.sendText(action.text, action.attachments);
        return;
      }
      case 'approve': {
        const p = this.pending.get(action.requestId);
        if (!p || p.kind !== 'approval') throw new Error('この許可要求は解決済みです');
        this.pending.delete(action.requestId);
        if (action.decision === 'deny') {
          this.respond(p, { behavior: 'deny', message: action.note?.trim() || 'ユーザーが拒否しました。' });
        } else {
          if (action.decision === 'allow_session') this.allowKeys.add(p.allowKey);
          this.respond(p, { behavior: 'allow', updatedInput: p.input });
        }
        this.emit({ type: 'approval_resolved', requestId: action.requestId, decision: action.decision });
        this.afterResolve();
        return;
      }
      case 'answer': {
        const p = this.pending.get(action.requestId);
        if (!p || p.kind !== 'question') throw new Error('この質問は解決済みです');
        this.pending.delete(action.requestId);
        this.respond(p, { behavior: 'allow', updatedInput: answerToUpdatedInput(p.input, action.text, action.answers) });
        this.emit({ type: 'question_resolved', requestId: action.requestId });
        this.afterResolve();
        return;
      }
      case 'interrupt':
        this.interrupt();
        return;
      case 'set_permission_mode':
        await this.setPermissionMode(action.mode);
        return;
      case 'set_model':
        await this.setModel(action.model, action.effort);
        return;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;
    this.denyAllPending('セッションを停止しました');
    const proc = this.proc;
    if (proc) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, STOP_TIMEOUT_MS);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.stdin.end();
      });
    }
    this.cleanup();
    this.stopped = true;
    this.setStatus('stopped');
  }

  // ---- 内部処理 ----

  private setStatus(status: SessionStatus, reason?: string): void {
    if (this.status === status && !reason) return;
    this.status = status;
    this.emit(reason ? { type: 'status', status, reason } : { type: 'status', status });
  }

  private emitMode(mode: PermissionMode): void {
    this.mode = mode;
    if (this.lastEmittedMode === mode) return;
    this.lastEmittedMode = mode;
    this.emit({ type: 'permission_mode', mode });
  }

  private write(obj: unknown): void {
    this.proc?.stdin.write(JSON.stringify(obj) + '\n');
  }

  private sendText(text: string, attachments?: Attachment[]): void {
    // 添付ファイルを変換できなければ、プロセスを起動する前に失敗させる（Hub が呼び出し元にエラーを返す）
    const { content, infos } = buildUserContent(this.opts.sessionId, text, attachments, this.deps.attachments);
    this.ensureProcess();
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    const ev: DriverEvent = { type: 'message', messageId: `u-${Date.now().toString(36)}-${this.msgCounter++}`, role: 'user', text };
    if (infos.length > 0) ev.attachments = infos;
    this.emit(ev);
    if (this.status !== 'waiting_approval' && this.status !== 'waiting_input') this.setStatus('running');
  }

  private ensureProcess(): void {
    if (this.proc) return;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', toClaudePermissionMode(this.mode),
      '--permission-prompt-tool', 'stdio',
      // 実行中に full_auto（bypassPermissions）へ切り替えられるようにする。付けても、モードが変わるまでは確認する
      '--allow-dangerously-skip-permissions',
    ];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.resumeToken) args.push('--resume', this.resumeToken);
    // 添付ファイルの置き場所を、確認なしで読めるフォルダに加える
    if (this.deps.attachments) args.push('--add-dir', this.deps.attachments.dir(this.opts.sessionId));
    // Hub の API で新しいセッションを作る方法を伝える（hub-guide.ts）
    const guide = hubGuide(this.deps.env);
    if (guide) args.push('--append-system-prompt', guide);

    const env = withHubEnv(childEnv(this.deps.env), this.opts.sessionId);

    this.setStatus('starting');
    this.killedOnPurpose = false;
    this.stderrTail = '';
    const proc = this.deps.launcher.spawn({ command: this.deps.claudePath, args, cwd: this.opts.cwd, env });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    proc.stdin.on('error', () => {
      /* プロセス終了時の EPIPE は exit で扱う */
    });
    proc.on('error', (err) => {
      this.emit({ type: 'error', message: `claude CLI を起動できませんでした: ${err.message}`, fatal: false });
    });
    proc.on('exit', (code) => this.onExit(proc, code));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg?.type) {
      case 'control_request':
        this.onControlRequest(msg);
        return;
      case 'control_cancel_request':
        this.onControlCancel(String(msg.request_id ?? ''));
        return;
      case 'control_response':
        this.onControlResponse(msg.response ?? {});
        return;
    }
    const r = this.mapper.map(msg);
    if (r.init) {
      this.resumeToken = r.init.sessionId;
      if (r.init.apiKeySource && r.init.apiKeySource !== 'none') {
        for (const e of r.events) this.emit(e);
        this.emit({ type: 'error', message: `API キー（${r.init.apiKeySource}）で動いているため停止しました。サブスクリプションでログインしてください`, fatal: true });
        void this.stop();
        return;
      }
    }
    if (r.permissionMode) this.emitMode(r.permissionMode);
    if (r.activity && (this.status === 'idle' || this.status === 'starting' || this.status === 'error')) {
      this.setStatus('running');
    }
    for (const e of r.events) {
      if (e.type === 'usage') {
        const sig = `${e.percent}|${e.resetsAt}`;
        if (this.lastUsage.get(e.label) === sig) continue;
        this.lastUsage.set(e.label, sig);
      }
      this.emit(e);
    }
    if (r.turnEnded) this.onTurnEnded(r.turnEnded);
  }

  // ---- 制御メッセージ（stdio） ----

  /** CLI からの問い合わせ。いまは can_use_tool（許可要求）だけを扱い、他は失敗で返す。 */
  private onControlRequest(msg: Json): void {
    const cliRequestId = String(msg.request_id ?? '');
    const req = msg.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: cliRequestId, error: `未対応の要求です: ${req.subtype}` } });
      return;
    }
    const toolName = String(req.tool_name ?? 'tool');
    const input: Record<string, unknown> = req.input && typeof req.input === 'object' ? req.input : {};
    const toolUseId = typeof req.tool_use_id === 'string' ? req.tool_use_id : undefined;

    if (this.stopping || this.stopped) {
      this.respondRaw(cliRequestId, { behavior: 'deny', message: 'セッションは停止中です' });
      return;
    }
    const allowKey = sessionAllowKey(toolName, input);
    const isInteractive = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
    if (!isInteractive && this.allowKeys.has(allowKey)) {
      this.respondRaw(cliRequestId, { behavior: 'allow', updatedInput: input });
      return;
    }
    const requestId = toolUseId && !this.pending.has(toolUseId) ? toolUseId : randomUUID();
    const prompt = buildPrompt(requestId, toolName, input, this.opts.cwd);
    this.pending.set(requestId, { kind: prompt.kind, cliRequestId, toolName, input, allowKey });
    this.emit(prompt.event);
    this.afterResolve();
  }

  /** CLI が問い合わせを取り下げた（中断など）。 */
  private onControlCancel(cliRequestId: string): void {
    for (const [id, p] of this.pending) {
      if (p.cliRequestId !== cliRequestId) continue;
      this.pending.delete(id);
      this.emitResolved(id, p);
      this.afterResolve();
      return;
    }
  }

  /** こちらから送った制御要求への応答。 */
  private onControlResponse(res: Json): void {
    const id = String(res.request_id ?? '');
    const o = this.outgoing.get(id);
    if (!o) return;
    this.outgoing.delete(id);
    clearTimeout(o.timer);
    if (res.subtype === 'success') o.resolve(res.response ?? {});
    else o.reject(new Error(String(res.error ?? '失敗しました')));
  }

  private sendControl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `agentpwa-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outgoing.delete(requestId);
        reject(new Error('claude CLI から応答がありません'));
      }, CONTROL_TIMEOUT_MS);
      this.outgoing.set(requestId, { resolve, reject, timer });
      this.write({ type: 'control_request', request_id: requestId, request });
    });
  }

  private respond(p: Pending, result: PermissionResult): void {
    this.respondRaw(p.cliRequestId, result);
  }

  private respondRaw(cliRequestId: string, result: PermissionResult): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: cliRequestId, response: result } });
  }

  // ---- 権限モード ----

  private async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.proc) {
      // プロセスが無いときは、次の起動の --permission-mode に使う
      this.emitMode(mode);
      return;
    }
    try {
      await this.sendControl({ subtype: 'set_permission_mode', mode: toClaudePermissionMode(mode) });
      this.emitMode(mode);
    } catch (e) {
      this.emit({ type: 'error', message: `権限モードを切り替えられませんでした: ${(e as Error).message}`, fatal: false });
    }
  }

  // ---- モデルとエフォート ----

  private emitModel(): void {
    const ev: DriverEvent = { type: 'model' };
    if (this.model) ev.model = this.model;
    if (this.effort) ev.effort = this.effort;
    if (this.resolved.model) ev.resolvedModel = this.resolved.model;
    if (this.resolved.effort) ev.resolvedEffort = this.resolved.effort;
    this.emit(ev);
  }

  /**
   * いまの設定で実際に使われるモデルとエフォートを CLI に聞き（get_settings の applied）、分かったら model を送り直す。
   * 失敗しても何もしない（UI は「既定」とだけ出す）。
   */
  private async refreshResolved(): Promise<void> {
    if (!this.deps.resolveDefaults) return;
    const gen = ++this.resolveGen;
    const want = `${this.model ?? ''}|${this.effort ?? ''}`;
    let res: Record<string, unknown> | undefined;
    try {
      res = this.proc ? await this.sendControl({ subtype: 'get_settings' }) : await this.probeSettings();
    } catch {
      return;
    }
    // 調べている間に設定が変わったり、別の調べ直しが始まったりしたら捨てる
    if (gen !== this.resolveGen || this.stopped || want !== `${this.model ?? ''}|${this.effort ?? ''}`) return;
    const applied = (res?.applied ?? {}) as Record<string, unknown>;
    const next: Resolved = {};
    if (typeof applied.model === 'string' && applied.model) next.model = applied.model;
    if (typeof applied.effort === 'string' && EFFORT_LEVELS.includes(applied.effort as EffortLevel)) next.effort = applied.effort as EffortLevel;
    if (next.model === this.resolved.model && next.effort === this.resolved.effort) return;
    this.resolved = next;
    this.emitModel();
  }

  /** プロセスが無いとき、同じ --model / --effort で CLI を短く起動して get_settings を聞く（ユーザーの指示は送らない）。 */
  private probeSettings(): Promise<Record<string, unknown>> {
    const args: string[] = [];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    return probeControl(this.deps, this.opts.cwd, args, { subtype: 'get_settings' });
  }

  /**
   * モデルとエフォートを切り替える（undefined は変えない、null は CLI の既定に戻す）。
   * プロセスが動いていれば制御要求で反映し（実行中のターンは次の API 呼び出しから効く）、
   * 止まっていれば次の起動の --model / --effort に使う。
   */
  private async setModel(model: string | null | undefined, effort: EffortLevel | null | undefined): Promise<void> {
    const nextModel = model === undefined ? this.model : model || undefined;
    const nextEffort = effort === undefined ? this.effort : effort ?? undefined;
    const errors: string[] = [];
    const before = `${this.model ?? ''}|${this.effort ?? ''}`;
    if (nextModel !== this.model) {
      if (this.proc) {
        try {
          // model を省くと CLI の既定に戻る
          await this.sendControl(nextModel ? { subtype: 'set_model', model: nextModel } : { subtype: 'set_model' });
          this.model = nextModel;
        } catch (e) {
          errors.push(`モデルを切り替えられませんでした: ${(e as Error).message}`);
        }
      } else {
        this.model = nextModel;
      }
    }
    if (nextEffort !== this.effort) {
      if (this.proc) {
        try {
          // null で起動時の --effort も含めて既定に戻る
          await this.sendControl({ subtype: 'apply_flag_settings', settings: { effortLevel: nextEffort ?? null } });
          this.effort = nextEffort;
        } catch (e) {
          errors.push(`エフォートを切り替えられませんでした: ${(e as Error).message}`);
        }
      } else {
        this.effort = nextEffort;
      }
    }
    if (errors.length > 0) this.emit({ type: 'error', message: errors.join('\n'), fatal: false });
    const changed = before !== `${this.model ?? ''}|${this.effort ?? ''}`;
    // 解決済みの値は設定が変わったら古くなるので、調べ直すまで外す
    if (changed) this.resolved = {};
    // 反映できた分を含む現在の設定を知らせる（何も変わらなくても、Web の切り替え中の表示を解くために送る）
    this.emitModel();
    if (changed) void this.refreshResolved();
  }

  // ---- ターン・プロセスの終わり ----

  private onTurnEnded(t: { isError: boolean; errors: string[] }): void {
    if (this.interrupting) {
      this.finishInterrupt();
      return;
    }
    // ターンが終わった時点で残っている問い合わせは CLI 側で取り下げられている
    this.denyAllPending('ターンが終了しました');
    if (t.isError && t.errors.length > 0) {
      this.emit({ type: 'error', message: t.errors.join('\n'), fatal: false });
    }
    this.setStatus('idle');
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.failOutgoing('claude CLI が終了しました');
    // CLI と一緒に終わったサブエージェントを、止まったことにする
    for (const e of this.mapper.stopSubagents()) this.emit(e);
    if (this.stopping) return;
    this.denyAllPending('claude CLI が終了しました');
    if (this.killedOnPurpose) return;
    const tail = this.stderrTail.trim().split('\n').slice(-3).join('\n');
    this.emit({
      type: 'error',
      message: `claude CLI が終了しました（code ${code ?? '?'}）。次の送信で再開します${tail ? `\n${tail}` : ''}`,
      fatal: false,
    });
    this.setStatus('error');
  }

  private interrupt(): void {
    if (!this.proc || this.status === 'idle' || this.interrupting) return;
    this.denyAllPending('ユーザーが中断しました');
    this.interrupting = true;
    // 応答は result（ターン終了）で分かるので、制御要求の応答は待たない
    this.sendControl({ subtype: 'interrupt' }).catch(() => {});
    this.interruptTimer = setTimeout(() => {
      // 応じないときはプロセスを終了する。次の送信で --resume して続きから始める
      if (!this.interrupting) return;
      this.killedOnPurpose = true;
      this.proc?.kill();
      this.finishInterrupt();
    }, INTERRUPT_TIMEOUT_MS);
  }

  private finishInterrupt(): void {
    this.interrupting = false;
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    this.setStatus('idle', '中断しました');
  }

  private emitResolved(requestId: string, p: Pending): void {
    if (p.kind === 'approval') this.emit({ type: 'approval_resolved', requestId, decision: 'deny' });
    else this.emit({ type: 'question_resolved', requestId });
  }

  private denyAllPending(message: string): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      this.respond(p, { behavior: 'deny', message });
      this.emitResolved(id, p);
    }
  }

  private failOutgoing(message: string): void {
    for (const [id, o] of [...this.outgoing]) {
      this.outgoing.delete(id);
      clearTimeout(o.timer);
      o.reject(new Error(message));
    }
  }

  /** 未解決の問い合わせに応じて状態を決める（許可待ちを質問待ちより優先する）。 */
  private afterResolve(): void {
    const kinds = [...this.pending.values()].map((p) => p.kind);
    if (kinds.includes('approval')) this.setStatus('waiting_approval');
    else if (kinds.includes('question')) this.setStatus('waiting_input');
    else if (this.status === 'waiting_approval' || this.status === 'waiting_input') this.setStatus(this.proc ? 'running' : 'idle');
  }

  private cleanup(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.failOutgoing('セッションを停止しました');
  }
}
