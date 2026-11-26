import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, DriverEvent, DriverSession, EffortLevel, PermissionMode, StartOptions, UserAction } from '@agentpwa/shared';
import { assertPlanQuota, environmentAuth, inspectAuth } from './auth.ts';
import { emitUsage, fileChanges, isEffort, permissions, toolEvent } from './mapping.ts';
import { RpcClient, type RpcId, type Wire } from './rpc.ts';

type Pending = { id: RpcId; params: Wire; kind: 'approval' | 'question'; method: string; choices?: ApprovalDecision[] };

export class CodexSession implements DriverSession {
  private threadId?: string;
  private activeTurn?: string;
  private completedTurns = new Set<string>();
  private turnReady?: () => void;
  private items = new Map<string, Wire>();
  private messages = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private mode: PermissionMode;
  private model?: string;
  private effort?: EffortLevel;
  private defaultModel?: string;
  private configuredEffort?: string;
  private applied?: { mode: PermissionMode; model?: string; effort?: EffortLevel };
  private models: Wire[] = [];
  private stopped = false;
  private stopPromise?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private rpc: RpcClient, private opts: StartOptions, private emit: (event: DriverEvent) => void) {
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.effort = opts.effort;
    rpc.onMessage = (msg) => this.receive(msg);
    rpc.onFailure = (error) => {
      if (this.stopped) return;
      this.emit({ type: 'error', message: error.message, fatal: !this.threadId });
      this.emit({ type: 'status', status: 'error' });
      void this.stop();
    };
  }

  async start() {
    this.emit({ type: 'status', status: 'starting' });
    try {
      await this.rpc.initialize();
      await this.guard(false);
      const { config } = await this.rpc.request('config/read', { cwd: this.opts.cwd, includeLayers: false });
      let cursor: string | undefined;
      do {
        const result = await this.rpc.request('model/list', { ...(cursor ? { cursor } : {}) });
        this.models.push(...(result.data ?? []));
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      const defaultModel = this.models.find((m) => m.isDefault);
      this.defaultModel = config.model ?? defaultModel?.model;
      this.configuredEffort = config.model_reasoning_effort ?? undefined;
      if (!this.defaultModel) throw new Error('既定のモデルを確認できません');
      if (this.effort && !this.validEffort(this.model, this.effort)) {
        this.emit({ type: 'error', message: `エフォート ${this.effort} は選択した Codex モデルでは使えません。既定を使います`, fatal: false });
        this.effort = undefined;
      }
      if (this.model && !this.models.some((m) => m.model === this.model || m.id === this.model)) {
        throw new Error('指定されたモデルは Codex のモデル一覧にありません');
      }
      const threadParams = () => {
        const perm = permissions(this.mode, this.opts.cwd);
        return {
          ...(this.opts.resumeToken ? { threadId: this.opts.resumeToken } : {}),
          cwd: this.opts.cwd, model: this.model ?? this.defaultModel, modelProvider: 'openai', serviceTier: 'default',
          approvalPolicy: perm.approvalPolicy, approvalsReviewer: perm.approvalsReviewer, sandbox: perm.sandbox,
          config: { model_reasoning_effort: this.effectiveEffort(), service_tier: 'default' },
        };
      };
      let result: Wire;
      try {
        result = await this.rpc.request(this.opts.resumeToken ? 'thread/resume' : 'thread/start', threadParams());
      } catch (error) {
        if (this.mode !== 'auto') throw error;
        this.mode = 'ask';
        this.emit({ type: 'error', message: '自動承認に対応していないため、毎回確認で開始します', fatal: false });
        result = await this.rpc.request(this.opts.resumeToken ? 'thread/resume' : 'thread/start', threadParams());
      }
      if (this.stopped) throw new Error('セッションは停止しています');
      this.threadId = result.thread?.id;
      if (!this.threadId) throw new Error('thread.id が返されませんでした');
      this.emit({ type: 'resume_token', token: this.threadId });
      // 自動レビューが反映されないサーバーでは、人が確認する設定に戻す。
      if (this.mode === 'auto' && result.approvalsReviewer !== 'auto_review') {
        this.mode = 'ask';
        this.emit({ type: 'error', message: '自動承認が反映されないため、毎回確認へ変更します', fatal: false });
        result = await this.rpc.request('thread/resume', { ...threadParams(), threadId: this.threadId });
      }
      this.emit({ type: 'permission_mode', mode: this.mode });
      this.emitModel(result.model, result.reasoningEffort);
      this.applied = { mode: this.mode, model: this.model, effort: this.effort };
      const active = result.thread.turns?.findLast((turn: Wire) => turn.status === 'inProgress');
      if (active) {
        this.activeTurn = active.id;
        for (const item of active.items ?? []) this.items.set(item.id, item);
      }
      this.emit({ type: 'status', status: this.activeTurn ? 'running' : 'idle' });
      if (this.opts.initialPrompt) await this.send({ type: 'send', text: this.opts.initialPrompt });
    } catch (error) {
      if (!this.stopped) {
        this.emit({ type: 'error', message: (error as Error).message, fatal: true });
        this.emit({ type: 'status', status: 'error' });
      }
      await this.stop();
      throw error;
    }
  }

  private emitModel(resolvedModel?: string, resolvedEffort?: string) {
    const catalog = this.models.find((m) => m.model === (this.model ?? this.defaultModel) || m.id === this.model);
    this.emit({ type: 'model', model: this.model, effort: this.effort,
      resolvedModel: resolvedModel ?? catalog?.model,
      resolvedEffort: isEffort(resolvedEffort) ? resolvedEffort : isEffort(this.effectiveEffort()) ? this.effectiveEffort() as EffortLevel : undefined,
    });
  }

  private effectiveEffort(): string {
    const catalog = this.models.find((m) => m.model === (this.model ?? this.defaultModel) || m.id === this.model);
    return this.effort ?? this.configuredEffort ?? catalog?.defaultReasoningEffort ?? 'medium';
  }

  private validEffort(model: string | undefined, effort: string) {
    if (!isEffort(effort)) return false;
    const catalog = this.models.find((m) => m.model === (model ?? this.defaultModel) || m.id === model);
    return !!catalog?.supportedReasoningEfforts?.some((e: Wire) => e.reasoningEffort === effort);
  }

  private async guard(quota: boolean) {
    const env = environmentAuth(process.env);
    if (env) {
      if (this.threadId) await this.halt(env.detail!);
      throw new Error(env.detail);
    }
    const auth = await inspectAuth(this.rpc, this.opts.cwd);
    if (!auth.ok) {
      if (this.threadId) await this.halt(auth.detail!);
      throw new Error(auth.detail);
    }
    if (quota) {
      const rates = await this.rpc.request('account/rateLimits/read');
      emitUsage(rates, this.emit);
      try { assertPlanQuota(rates); }
      catch (error) {
        if (this.activeTurn) await this.halt((error as Error).message);
        throw error;
      }
    }
    if (this.stopped) throw new Error('セッションは停止しています');
  }

  private async halt(message: string) {
    this.emit({ type: 'error', message, fatal: true });
    this.emit({ type: 'status', status: 'error' });
    await this.stop();
  }

  send(action: UserAction): Promise<void> {
    // stop はキューを待たず実行する。通常操作は順に処理して turn/start の競合を避ける。
    const result = this.queue.then(async () => {
      if (this.stopped) throw new Error('セッションは停止しています');
      try { await this.act(action); }
      catch (error) {
        if (!this.stopped) this.emit({ type: 'error', message: (error as Error).message, fatal: false });
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async act(action: UserAction) {
    switch (action.type) {
      case 'send': {
        if (action.attachments?.length) throw new Error('この Driver は添付ファイルにまだ対応していません');
        if (!action.text.trim()) throw new Error('指示が空です');
        await this.guard(true);
        const messageId = randomUUID();
        const input = [{ type: 'text', text: action.text, text_elements: [] }];
        const activeTurn = this.activeTurn;
        if (activeTurn) {
          await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: activeTurn, input, clientUserMessageId: messageId });
        } else {
          const perm = permissions(this.mode, this.opts.cwd);
          let timeout = false;
          const ready = new Promise<void>((resolve) => { this.turnReady = resolve; });
          const timer = setTimeout(() => { timeout = true; this.turnReady?.(); }, 20_000);
          try {
            const result = await this.rpc.request('turn/start', {
              threadId: this.threadId, input, clientUserMessageId: messageId, cwd: this.opts.cwd,
              approvalPolicy: perm.approvalPolicy, approvalsReviewer: perm.approvalsReviewer, sandboxPolicy: perm.sandboxPolicy,
              model: this.model ?? this.defaultModel, effort: this.effectiveEffort(), serviceTier: 'default',
              collaborationMode: { mode: this.mode === 'plan' ? 'plan' : 'default', settings: {
                model: this.model ?? this.defaultModel, reasoning_effort: this.effectiveEffort(), developer_instructions: null,
              } },
            });
            this.applied = { mode: this.mode, model: this.model, effort: this.effort };
            // 応答の直後は、サーバー内でまだターンが登録されていないことがある。
            // started / completed を待ち、中断や steer が早すぎる競合を避ける。
            if (result.turn?.id && !this.completedTurns.has(result.turn.id)) this.activeTurn = result.turn.id;
            await ready;
            if (timeout) {
              await this.stop();
              throw new Error('ターンの開始通知が届かないため停止しました');
            }
          } catch (error) {
            if (this.applied && !this.stopped) {
              if (this.mode !== this.applied.mode) {
                this.mode = this.applied.mode;
                this.emit({ type: 'permission_mode', mode: this.mode });
              }
              if (this.model !== this.applied.model || this.effort !== this.applied.effort) {
                this.model = this.applied.model; this.effort = this.applied.effort; this.emitModel();
              }
            }
            throw error;
          } finally { clearTimeout(timer); this.turnReady = undefined; }
        }
        if (this.stopped) return;
        this.emit({ type: 'message', messageId, role: 'user', text: action.text });
        this.waitStatus();
        return;
      }
      case 'interrupt':
        if (this.activeTurn) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurn });
        // idle は turn/completed を受信した時点で通知する。
        return;
      case 'approve': {
        const pending = this.pending.get(action.requestId);
        if (!pending || pending.kind !== 'approval') throw new Error('対応する承認要求がありません');
        if (!pending.choices?.includes(action.decision)) throw new Error('この承認要求では選べない決定です');
        if (action.decision !== 'deny') await this.guard(true);
        if (this.pending.get(action.requestId) !== pending) throw new Error('この承認要求はすでに解決しています');
        let result: Wire;
        if (pending.method === 'item/permissions/requestApproval') {
          result = { permissions: action.decision === 'deny' ? {} : pending.params.permissions, scope: action.decision === 'allow_session' ? 'session' : 'turn' };
        } else {
          const available = pending.params.availableDecisions;
          result = { decision: action.decision === 'allow' ? 'accept' : action.decision === 'allow_session' ? 'acceptForSession' : available?.includes('decline') || !available ? 'decline' : 'cancel' };
        }
        this.rpc.respond(pending.id, result);
        this.resolvePending(action.requestId, action.decision);
        if (action.note) this.emit({ type: 'error', message: '承認の補足文を返す欄が app-server にありません。追加指示として送ってください', fatal: false });
        return;
      }
      case 'answer': {
        const pending = this.pending.get(action.requestId);
        if (!pending || pending.kind !== 'question') throw new Error('対応する質問がありません');
        const questions: Wire[] = pending.params.questions;
        const answers = action.answers ?? (questions.length === 1 ? [action.text] : undefined);
        if (!answers || answers.length !== questions.length || answers.some((s) => typeof s !== 'string' || !s.trim())) throw new Error('すべての質問への回答が必要です');
        await this.guard(true);
        if (this.pending.get(action.requestId) !== pending) throw new Error('この質問はすでに解決しています');
        this.rpc.respond(pending.id, { answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: [answers[i]] }])) });
        this.resolvePending(action.requestId);
        return;
      }
      case 'set_permission_mode':
        this.mode = action.mode;
        this.emit({ type: 'permission_mode', mode: this.mode });
        return;
      case 'set_model': {
        const nextModel = action.model === undefined ? this.model : action.model ?? undefined;
        const nextEffort = action.effort === undefined ? this.effort : action.effort ?? undefined;
        if (nextModel && !this.models.some((m) => m.model === nextModel || m.id === nextModel)) {
          this.emit({ type: 'error', message: '指定されたモデルは Codex のモデル一覧にありません', fatal: false });
        } else if (nextEffort && !this.validEffort(nextModel, nextEffort)) {
          this.emit({ type: 'error', message: '選択したモデルでは指定のエフォートを使えません', fatal: false });
        } else { this.model = nextModel; this.effort = nextEffort; }
        this.emitModel();
        return;
      }
    }
  }

  private waitStatus() {
    if (this.stopped) return;
    const requests = [...this.pending.values()];
    this.emit({ type: 'status', status: requests.some((r) => r.kind === 'approval') ? 'waiting_approval' : requests.length ? 'waiting_input' : this.activeTurn ? 'running' : 'idle' });
  }

  private resolvePending(key: string, decision: ApprovalDecision = 'deny', status = true) {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    this.emit(pending.kind === 'question' ? { type: 'question_resolved', requestId: key } : { type: 'approval_resolved', requestId: key, decision });
    if (status) this.waitStatus();
  }

  private receive(msg: Wire) {
    if (this.stopped || !msg.method) return;
    const p: Wire = msg.params ?? {};
    if (p.threadId && this.threadId && p.threadId !== this.threadId) {
      if (msg.id !== undefined) this.rpc.unsupported(msg.id);
      return;
    }
    if (msg.id !== undefined) { this.request(msg.id, msg.method, p); return; }
    switch (msg.method) {
      case 'account/updated':
        if (p.authMode !== 'chatgpt') {
          this.emit({ type: 'error', message: '認証方式が変わりました。従量課金を避けるため停止します', fatal: true });
          void this.stop();
        }
        break;
      case 'account/rateLimits/updated':
        emitUsage(p, this.emit);
        // 通知は部分更新で ordinaryUsageAllowed を持たない。明示的な枠切れだけで停止し、
        // 次の操作では read の権威ある値を取り直す。
        if ([p.rateLimits?.primary, p.rateLimits?.secondary].some((w) => w?.usedPercent >= 100) || p.rateLimits?.rateLimitReachedType || p.rateLimits?.spendControlReached === true || p.rateLimits?.credits?.hasCredits === true || p.rateLimits?.credits?.unlimited === true) {
          this.emit({ type: 'error', message: 'ChatGPT の利用枠が不足しています。追加クレジットを使わず停止します', fatal: true });
          void this.stop();
        }
        break;
      case 'turn/started':
        this.turnReady?.();
        if (this.completedTurns.has(p.turn.id)) return;
        this.activeTurn = p.turn.id;
        this.waitStatus();
        break;
      case 'turn/completed':
        this.turnReady?.();
        this.completedTurns.add(p.turn.id);
        if (this.completedTurns.size > 128) this.completedTurns.delete(this.completedTurns.values().next().value!);
        if (this.activeTurn && p.turn.id !== this.activeTurn) return;
        this.activeTurn = undefined;
        for (const key of this.pending.keys()) this.resolvePending(key, 'deny', false);
        for (const [messageId, text] of this.messages) this.emit({ type: 'message', role: 'assistant', messageId, text });
        this.messages.clear();
        this.items.clear();
        if (p.turn.status === 'failed') {
          this.emit({ type: 'error', message: 'Codex のターンが失敗しました', fatal: false });
          this.emit({ type: 'status', status: 'error' });
        } else this.emit({ type: 'status', status: 'idle', ...(p.turn.status === 'interrupted' ? { reason: '中断しました' } : {}) });
        break;
      case 'item/agentMessage/delta':
        this.messages.set(p.itemId, (this.messages.get(p.itemId) ?? '') + p.delta);
        this.emit({ type: 'message_delta', messageId: p.itemId, text: p.delta });
        break;
      case 'item/started':
      case 'item/completed': {
        const item: Wire = p.item;
        this.items.set(item.id, item);
        const done = msg.method === 'item/completed';
        if (done && item.type === 'agentMessage') {
          this.messages.delete(item.id);
          this.emit({ type: 'message', messageId: item.id, role: 'assistant', text: item.text });
        } else {
          const event = toolEvent(item, done);
          if (event) this.emit(event);
        }
        break;
      }
      case 'serverRequest/resolved': {
        const key = this.requestKey(p.requestId);
        this.resolvePending(key);
        break;
      }
      case 'error':
        this.emit({ type: 'error', message: p.willRetry ? 'Codex の通信でエラーが発生しました。再試行中です' : 'Codex でエラーが発生しました', fatal: false });
        if (!p.willRetry) this.emit({ type: 'status', status: 'error' });
        break;
    }
  }

  private requestKey(id: RpcId) { return `rpc:${typeof id}:${id}`; }

  private request(id: RpcId, method: string, p: Wire) {
    const key = this.requestKey(id);
    if (['item/tool/requestUserInput', 'tool/requestUserInput'].includes(method)) {
      const questions: Wire[] = p.questions ?? [];
      if (!questions.length || questions.some((q) => q.isSecret)) {
        this.rpc.unsupported(id);
        this.emit({ type: 'error', message: '秘密情報の質問は Hub の履歴に保存できないため拒否しました', fatal: false });
        return;
      }
      this.pending.set(key, { id, params: p, method, kind: 'question' });
      this.emit({ type: 'question', requestId: key, prompt: questions.map((q) => q.question).join('\n'),
        questions: questions.map((q) => ({ question: q.question, header: q.header, options: (q.options ?? []).map((o: Wire) => ({ label: o.label, description: o.description })) })),
        ...(questions.length === 1 ? { options: (questions[0].options ?? []).map((o: Wire) => o.label) } : {}),
      });
      this.waitStatus();
      return;
    }
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
      const item = this.items.get(p.itemId) ?? {};
      const changes = method === 'item/fileChange/requestApproval' ? fileChanges(item) : undefined;
      // 差分不明のファイル変更は承認できない。要求自体は拒否してターンを止めない。
      if (changes && !changes.length) {
        this.rpc.respond(id, { decision: 'decline' });
        this.emit({ type: 'error', message: '変更差分が不明なため、ファイル変更を拒否しました', fatal: false });
        return;
      }
      const available: unknown[] = p.availableDecisions ?? ['accept', 'acceptForSession', 'decline'];
      const choices: ApprovalDecision[] = method === 'item/permissions/requestApproval' ? ['allow', 'allow_session', 'deny'] : [
        ...(available.includes('accept') ? ['allow' as const] : []),
        ...(available.includes('acceptForSession') ? ['allow_session' as const] : []),
        ...(available.includes('decline') || available.includes('cancel') ? ['deny' as const] : []),
      ];
      if (!choices.length) { this.rpc.unsupported(id); return; }
      this.pending.set(key, { id, method, params: p, kind: 'approval', choices });
      this.emit({ type: 'approval_request', requestId: key,
        kind: changes ? 'file_change' : method === 'item/permissions/requestApproval' ? 'permission' : 'command',
        title: method === 'item/permissions/requestApproval' ? `${p.reason ?? '追加権限を許可してよいですか？'} ${JSON.stringify(p.permissions)}` : p.reason ?? (changes ? 'ファイルを変更してよいですか？' : 'コマンドを実行してよいですか？'),
        command: p.command ?? item.command, cwd: p.cwd ?? item.cwd, changes, choices,
      });
      this.waitStatus();
      return;
    }
    this.rpc.unsupported(id);
    this.emit({ type: 'error', message: `未対応の app-server 要求を拒否しました: ${method}`, fatal: false });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.turnReady?.();
    this.stopPromise = (async () => {
      await this.rpc.close();
      for (const key of this.pending.keys()) this.resolvePending(key, 'deny', false);
      for (const [messageId, text] of this.messages) this.emit({ type: 'message', messageId, role: 'assistant', text });
      this.messages.clear();
      this.emit({ type: 'status', status: 'stopped' });
    })();
    return this.stopPromise;
  }
}
