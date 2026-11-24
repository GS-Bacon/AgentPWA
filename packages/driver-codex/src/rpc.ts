import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

// app-server の版に依存する JSON はこの境界で扱い、共有型には持ち込まない。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export type RpcId = string | number;
export type Launch = (cwd?: string) => ChildProcessWithoutNullStreams;

export function localLaunch(codexPath: string, env: NodeJS.ProcessEnv): Launch {
  return (cwd) => spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  });
}

export class RpcClient {
  private nextId = 0;
  private pending = new Map<RpcId, { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private closing?: Promise<void>;
  private exited: Promise<void>;
  onMessage: (message: Wire) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(private child: ChildProcessWithoutNullStreams, private timeoutMs = 20_000) {
    this.exited = new Promise((resolve) => child.once('close', () => resolve()));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.closed) return;
      try {
        const msg = JSON.parse(line) as Wire;
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
        if (msg.id !== undefined && !msg.method) {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          // サーバーのエラー本文にはキーや入力が含まれ得るので、そのまま公開しない。
          if (msg.error) pending.reject(new Error(`app-server の要求が失敗しました（code: ${Number(msg.error.code) || 0}）`));
          else pending.resolve(msg.result ?? {});
        } else {
          this.onMessage(msg);
        }
      } catch {
        this.fail(new Error('app-server の JSONL を解釈できませんでした'));
      }
    });
    child.stderr.resume(); // 認証情報を含み得る stderr は記録しない。
    child.stdin.on('error', () => this.fail(new Error('app-server の入力が切断されました')));
    child.once('error', () => this.fail(new Error('Codex を起動できません。codexPath に実行ファイルを指定してください')));
    child.once('close', () => {
      lines.close();
      this.fail(new Error('app-server が終了しました'));
    });
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.onFailure(error);
    if (!this.closing) void this.close();
  }

  private write(message: Wire) {
    if (this.closed) throw new Error('app-server との接続は終了しています');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: Wire = {}): Promise<Wire> {
    if (this.closed) return Promise.reject(new Error('app-server との接続は終了しています'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`app-server の応答がタイムアウトしました: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { this.fail(error as Error); }
    });
  }

  notify(method: string, params?: Wire) { this.write({ method, ...(params ? { params } : {}) }); }
  respond(id: RpcId, result: Wire) { this.write({ id, result }); }
  unsupported(id: RpcId) { this.write({ id, error: { code: -32601, message: '未対応の要求です' } }); }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'agentpwa', title: 'AgentPWA', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer); p.reject(new Error('app-server を停止しました'));
      }
      this.pending.clear();
      this.child.stdin.end();
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      // stdio を閉じても残る子プロセスは、OS に終了を要求する。
      let termination: Promise<void> | undefined;
      const killTimer = setTimeout(() => {
        const pid = this.child.pid;
        if (pid && this.child.exitCode === null && this.child.signalCode === null) {
          if (process.platform === 'win32') {
            termination = new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
              if (error) this.child.kill('SIGKILL');
              resolve();
            }));
          } else {
            try { process.kill(-pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
          }
        } else this.child.kill('SIGKILL');
      }, 300);
      try { await this.exited; await termination; }
      finally { clearTimeout(killTimer); }
    })();
    return this.closing;
  }
}
