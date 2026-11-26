// Hub の起動。127.0.0.1 でだけ待ち受ける（外への公開は tailscale serve に任せる）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDriver, AgentKind } from '@agentpwa/shared';
import { createClaudeDriver } from '@agentpwa/driver-claude';
import { autoFillConfig } from './autoconfig.ts';
import { withCodexPath } from './codex-path.ts';
import { loadConfig, watchConfig } from './config.ts';
import { Store } from './db.ts';
import { createFakeDriver } from './fake-driver.ts';
import { buildServer } from './server.ts';
import { SessionManager } from './sessions.ts';

const HOST = '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));

async function loadCodexDriver(mode: 'fake' | 'driver', codexPath?: string): Promise<{ driver: AgentDriver; fake: boolean }> {
  if (mode === 'driver') {
    try {
      // Codex 担当の Driver（packages/driver-codex）。まだ無い環境でも Hub が型エラーにならないよう動的に読む
      const name = '@agentpwa/driver-codex';
      const mod = (await import(name)) as { createCodexDriver: (options?: { codexPath?: string }) => AgentDriver };
      if (codexPath) return { driver: mod.createCodexDriver({ codexPath }), fake: false };
      // パスを指定しないときは、Codex アプリの更新で codex.exe の場所が変わっても追えるよう、確認と起動のたびに PATH を直す
      return { driver: withCodexPath(mod.createCodexDriver()), fake: false };
    } catch (e) {
      console.warn(`[hub] driver-codex を読み込めないため、フェイク Driver を使います: ${(e as Error).message}`);
    }
  }
  return { driver: createFakeDriver({ kind: 'codex', fixturesDir: path.resolve(here, '../fixtures/codex') }), fake: true };
}

async function main(): Promise<void> {
  const first = loadConfig();
  const configPath = first.path;
  if (first.created) console.log(`[hub] 設定ファイルを作りました: ${configPath}`);
  // 空の項目を分かる範囲で埋める（Tailscale のユーザー、ホームフォルダ）。失敗しても起動は続ける
  const filled = await autoFillConfig(configPath, { created: first.created }).catch((e: Error) => {
    console.warn(`[hub] 設定の自動設定に失敗しました: ${e.message}`);
    return { changes: [] };
  });
  for (const c of filled.changes) console.log(`[hub] 自動設定: ${c}`);
  const { config } = filled.changes.length > 0 ? loadConfig(configPath) : first;
  if (config.folders.length === 0) console.log('[hub] プロジェクトはまだありません。画面の「新しいプロジェクト」から作れます');
  if (config.allowedUsers.length === 0) {
    console.warn('[hub] allowedUsers が空です。tailscale serve 経由で開こうとした人は、このPCのブラウザの「設定 → アクセス」から許可できます');
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'hub.db'));

  // セッションの中の AI が Hub の API を呼べるよう、子プロセスに URL を伝える（driver-claude の hub-guide.ts）
  process.env.AGENTPWA_HUB_URL = `http://${HOST}:${config.port}`;

  const codex = await loadCodexDriver(config.codex, config.codexPath);
  const drivers = new Map<AgentKind, AgentDriver>([
    ['claude', createClaudeDriver({ claudePath: config.claudePath })],
    ['codex', codex.driver],
  ]);
  const manager = new SessionManager(store, drivers, config);
  manager.init();

  const webDist = path.resolve(here, '../../web/dist');
  const app = await buildServer({ manager, config, configPath, webDist, fakeAgents: codex.fake ? ['codex'] : [] });
  await app.listen({ host: HOST, port: config.port });
  console.log(`[hub] http://${HOST}:${config.port} で待ち受けています（設定: ${configPath}）`);
  if (!fs.existsSync(path.join(webDist, 'index.html'))) console.log('[hub] Web は未ビルドです。開発中は npm run dev の Vite（http://127.0.0.1:5173）を開いてください');

  const unwatch = watchConfig(configPath, config, () => manager.notifyConfigChanged());

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    console.log('[hub] 終了します');
    unwatch();
    await manager.shutdown();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
