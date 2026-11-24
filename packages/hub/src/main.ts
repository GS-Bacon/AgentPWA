// Hub の起動。127.0.0.1 でだけ待ち受ける（外への公開は tailscale serve に任せる）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDriver, AgentKind } from '@agentpwa/shared';
import { createClaudeDriver } from '@agentpwa/driver-claude';
import { loadConfig, watchConfig } from './config.ts';
import { Store } from './db.ts';
import { createFakeDriver } from './fake-driver.ts';
import { buildServer } from './server.ts';
import { SessionManager } from './sessions.ts';

const HOST = '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));

async function loadCodexDriver(mode: 'fake' | 'driver'): Promise<{ driver: AgentDriver; fake: boolean }> {
  if (mode === 'driver') {
    try {
      // Codex 担当の Driver（packages/driver-codex）。まだ無い環境でも Hub が型エラーにならないよう動的に読む
      const name = '@agentpwa/driver-codex';
      const mod = (await import(name)) as { createCodexDriver: () => AgentDriver };
      return { driver: mod.createCodexDriver(), fake: false };
    } catch (e) {
      console.warn(`[hub] driver-codex を読み込めないため、フェイク Driver を使います: ${(e as Error).message}`);
    }
  }
  return { driver: createFakeDriver({ kind: 'codex', fixturesDir: path.resolve(here, '../fixtures/codex') }), fake: true };
}

async function main(): Promise<void> {
  const { config, path: configPath, created } = loadConfig();
  if (created) console.log(`[hub] 設定ファイルを作りました: ${configPath}`);
  if (config.folders.length === 0) console.warn(`[hub] 起動できるフォルダがありません。${configPath} の folders に追加してください`);
  if (config.allowedUsers.length === 0) console.warn('[hub] allowedUsers が空です。tailscale serve 経由のアクセスはすべて拒否されます');

  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'hub.db'));

  const codex = await loadCodexDriver(config.codex);
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
