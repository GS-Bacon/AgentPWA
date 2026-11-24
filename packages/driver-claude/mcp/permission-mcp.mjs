#!/usr/bin/env node
// AgentPWA: claude CLI の --permission-prompt-tool 用の最小 MCP サーバー（stdio）。
//
// claude CLI がこのスクリプトを子プロセスとして起動する。許可の問い合わせ（tools/call）を受けたら、
// Driver が 127.0.0.1 で開いている TCP ポートへ 1 行の JSON で転送し、返ってきた決定をそのまま返す。
// 依存パッケージを持たないよう、MCP は改行区切りの JSON-RPC として手で実装している。
//
// 環境変数:
//   AGENTPWA_BRIDGE_PORT  Driver の TCP ポート
//   AGENTPWA_BRIDGE_TOKEN セッションごとの合言葉（Driver がどのセッションの問い合わせか判別する）

import net from 'node:net';
import readline from 'node:readline';

const PORT = Number(process.env.AGENTPWA_BRIDGE_PORT);
const TOKEN = process.env.AGENTPWA_BRIDGE_TOKEN ?? '';
const TOOL_NAME = 'approve';

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Driver に問い合わせて決定（{behavior: 'allow' | 'deny', ...}）を受け取る。 */
function askDriver(args) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT });
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(
        JSON.stringify({
          token: TOKEN,
          toolName: args.tool_name,
          input: args.input ?? {},
          toolUseId: args.tool_use_id,
        }) + '\n',
      );
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, nl)));
        } catch {
          finish({ behavior: 'deny', message: 'AgentPWA: 決定を読み取れませんでした' });
        }
      }
    });
    sock.on('error', () => finish({ behavior: 'deny', message: 'AgentPWA Hub に接続できませんでした' }));
    sock.on('close', () => finish({ behavior: 'deny', message: 'AgentPWA Hub との接続が切れました' }));
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  // 通知（id なし）には返事をしない
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentpwa', version: '0.1.0' },
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: [
          {
            name: TOOL_NAME,
            description: 'AgentPWA の画面でユーザーに許可を求める',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      });
      return;
    case 'tools/call': {
      if (params?.name !== TOOL_NAME) {
        replyError(id, -32602, `unknown tool: ${params?.name}`);
        return;
      }
      const decision = await askDriver(params.arguments ?? {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
      return;
    }
    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
