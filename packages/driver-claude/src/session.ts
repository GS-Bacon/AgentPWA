// 1つの Claude セッション（claude CLI の子プロセス）を管理する。
//
// - プロセスは送信が必要になったときに起動し、ターンが終わっても標準入力を開いたまま次の指示を待つ。
// - プロセスが無い状態で送信されたら、`--resume <session_id>` で起動し直してから送る（Hub 再起動後の再開も同じ）。
// - 許可要求は PermissionBridge 経由で受け、Hub からの approve / answer で決定を返す。
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { DriverEvent, DriverSession, SessionStatus, StartOptions, UserAction } from '@agentpwa/shared';
import type { PermissionBridge, PermissionQuery, PermissionResult } from './bridge.ts';
import { StreamMapper } from './mapper.ts';
import { answerToUpdatedInput, buildPrompt, sessionAllowKey, toClaudePermissionMode } from './permissions.ts';

const MCP_SERVER_NAME = 'agentpwa';
const MCP_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;
const PERMISSION_SCRIPT = fileURLToPath(new URL('../mcp/permission-mcp.mjs', import.meta.url));
/** 中断要求に CLI が応じないとき、プロセスを終了させるまでの待ち時間 */
const INTERRUPT_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 3000;
/** 親の Claude Code から受け継ぐと子の CLI の動作が変わる環境変数 */
const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

interface Pending {
  kind: 'approval' | 'question';
  toolName: string;
  input: Record<string, unknown>;
  allowKey: string;
  resolve: (r: PermissionResult) => void;
}

export interface ClaudeSessionDeps {
  claudePath: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
  bridge: PermissionBridge;
}

export class ClaudeSession implements DriverSession {
  private proc: ChildProcess | null = null;
  private status: SessionStatus = 'starting';
  private pending = new Map<string, Pending>();
  private allowKeys = new Set<string>();
  private resumeToken: string | undefined;
  private mapper = new StreamMapper();
  private token = '';
  private mcpConfigPath = '';
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
  }

  async init(): Promise<void> {
    await this.deps.bridge.ensureStarted();
    this.token = this.deps.bridge.register((q, signal) => this.onPermission(q, signal));
    this.mcpConfigPath = await this.writeMcpConfig();
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
      case 'send':
        this.sendText(action.text);
        return;
      case 'approve': {
        const p = this.pending.get(action.requestId);
        if (!p || p.kind !== 'approval') throw new Error('この許可要求は解決済みです');
        this.pending.delete(action.requestId);
        if (action.decision === 'deny') {
          p.resolve({ behavior: 'deny', message: action.note?.trim() || 'ユーザーが拒否しました。' });
        } else {
          if (action.decision === 'allow_session') this.allowKeys.add(p.allowKey);
          p.resolve({ behavior: 'allow', updatedInput: p.input });
        }
        this.emit({ type: 'approval_resolved', requestId: action.requestId, decision: action.decision });
        this.afterResolve();
        return;
      }
      case 'answer': {
        const p = this.pending.get(action.requestId);
        if (!p || p.kind !== 'question') throw new Error('この質問は解決済みです');
        this.pending.delete(action.requestId);
        p.resolve({ behavior: 'allow', updatedInput: answerToUpdatedInput(p.input, action.text) });
        this.emit({ type: 'question_resolved', requestId: action.requestId });
        this.afterResolve();
        return;
      }
      case 'interrupt':
        this.interrupt();
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
        proc.stdin?.end();
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

  private sendText(text: string): void {
    this.ensureProcess();
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.proc!.stdin!.write(line + '\n');
    this.emit({ type: 'message', messageId: `u-${Date.now().toString(36)}-${this.msgCounter++}`, role: 'user', text });
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
      '--permission-mode', toClaudePermissionMode(this.opts.permissionMode),
      '--mcp-config', this.mcpConfigPath,
      '--permission-prompt-tool', MCP_TOOL,
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.resumeToken) args.push('--resume', this.resumeToken);

    const env: NodeJS.ProcessEnv = { ...this.deps.env };
    for (const k of STRIP_ENV) delete env[k];
    // 許可待ちの間に MCP ツール呼び出しがタイムアウトしないよう、上限を長くする（24時間）
    if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(24 * 60 * 60 * 1000);

    this.setStatus('starting');
    this.killedOnPurpose = false;
    this.stderrTail = '';
    const proc = spawn(this.deps.claudePath, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    proc.stdin!.on('error', () => {
      /* プロセス終了時の EPIPE は exit で扱う */
    });
    proc.on('error', (err) => {
      this.emit({ type: 'error', message: `claude CLI を起動できませんでした: ${err.message}`, fatal: false });
    });
    proc.on('exit', (code) => this.onExit(proc, code));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
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

  private onExit(proc: ChildProcess, code: number | null): void {
    if (this.proc !== proc) return;
    this.proc = null;
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
    // stream-json 入力の control_request（Agent SDK の interrupt() と同じ経路）で中断を頼む
    const req = { type: 'control_request', request_id: `int-${Date.now().toString(36)}`, request: { subtype: 'interrupt' } };
    this.proc.stdin!.write(JSON.stringify(req) + '\n');
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

  private async onPermission(q: PermissionQuery, signal: AbortSignal): Promise<PermissionResult> {
    if (this.stopping || this.stopped) return { behavior: 'deny', message: 'セッションは停止中です' };
    const allowKey = sessionAllowKey(q.toolName, q.input);
    const isInteractive = q.toolName === 'AskUserQuestion' || q.toolName === 'ExitPlanMode';
    if (!isInteractive && this.allowKeys.has(allowKey)) {
      return { behavior: 'allow', updatedInput: q.input };
    }
    const requestId = q.toolUseId && !this.pending.has(q.toolUseId) ? q.toolUseId : randomUUID();
    const prompt = buildPrompt(requestId, q.toolName, q.input, this.opts.cwd);
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { kind: prompt.kind, toolName: q.toolName, input: q.input, allowKey, resolve });
      this.emit(prompt.event);
      this.afterResolve();
      signal.addEventListener('abort', () => {
        // CLI 側が問い合わせを取り下げた（中断・終了など）
        const p = this.pending.get(requestId);
        if (!p) return;
        this.pending.delete(requestId);
        this.emitResolved(requestId, p);
        this.afterResolve();
      });
    });
  }

  private emitResolved(requestId: string, p: Pending): void {
    if (p.kind === 'approval') this.emit({ type: 'approval_resolved', requestId, decision: 'deny' });
    else this.emit({ type: 'question_resolved', requestId });
  }

  private denyAllPending(message: string): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message });
      this.emitResolved(id, p);
    }
  }

  /** 未解決の問い合わせに応じて状態を決める（許可待ちを質問待ちより優先する）。 */
  private afterResolve(): void {
    const kinds = [...this.pending.values()].map((p) => p.kind);
    if (kinds.includes('approval')) this.setStatus('waiting_approval');
    else if (kinds.includes('question')) this.setStatus('waiting_input');
    else if (this.status === 'waiting_approval' || this.status === 'waiting_input') this.setStatus(this.proc ? 'running' : 'idle');
  }

  private async writeMcpConfig(): Promise<string> {
    const port = await this.deps.bridge.ensureStarted();
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'stdio',
          command: this.deps.nodePath,
          args: [PERMISSION_SCRIPT],
          env: { AGENTPWA_BRIDGE_PORT: String(port), AGENTPWA_BRIDGE_TOKEN: this.token },
        },
      },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpwa-'));
    const file = path.join(dir, `mcp-${this.opts.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    return file;
  }

  private cleanup(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.deps.bridge.unregister(this.token);
    if (this.mcpConfigPath) {
      fs.rmSync(path.dirname(this.mcpConfigPath), { recursive: true, force: true });
    }
  }
}
