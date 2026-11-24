// 許可の問い合わせを受ける TCP サーバー（127.0.0.1 のみ）。
// mcp/permission-mcp.mjs が 1 接続につき 1 行の JSON で問い合わせ、決定を 1 行の JSON で受け取る。
// どのセッションからの問い合わせかは、セッションごとに作る token で判別する。
import net from 'node:net';
import { randomBytes } from 'node:crypto';

export interface PermissionQuery {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

/** claude CLI に返す決定（--permission-prompt-tool の戻り値）。 */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type PermissionHandler = (q: PermissionQuery, signal: AbortSignal) => Promise<PermissionResult>;

export class PermissionBridge {
  private server: net.Server | null = null;
  private port = 0;
  private handlers = new Map<string, PermissionHandler>();
  private starting: Promise<number> | null = null;

  /** サーバーを起動してポート番号を返す（2回目以降は同じポート）。 */
  ensureStarted(): Promise<number> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.onConnection(sock));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
    return this.starting;
  }

  register(handler: PermissionHandler): string {
    const token = randomBytes(24).toString('hex');
    this.handlers.set(token, handler);
    return token;
  }

  unregister(token: string): void {
    this.handlers.delete(token);
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.starting = null;
  }

  private onConnection(sock: net.Socket): void {
    let buf = '';
    let handled = false;
    const ac = new AbortController();
    sock.setEncoding('utf8');
    sock.on('close', () => ac.abort());
    sock.on('error', () => ac.abort());
    sock.on('data', async (chunk: string) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        if (buf.length > 1_000_000) sock.destroy();
        return;
      }
      handled = true;
      let result: PermissionResult;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { token?: string } & PermissionQuery;
        const handler = msg.token ? this.handlers.get(msg.token) : undefined;
        if (!handler) {
          result = { behavior: 'deny', message: 'AgentPWA: 不明なセッションからの問い合わせです' };
        } else {
          result = await handler({ toolName: msg.toolName, input: msg.input ?? {}, toolUseId: msg.toolUseId }, ac.signal);
        }
      } catch (e) {
        result = { behavior: 'deny', message: `AgentPWA: ${(e as Error).message}` };
      }
      if (!sock.destroyed) sock.end(JSON.stringify(result) + '\n');
    });
  }
}
