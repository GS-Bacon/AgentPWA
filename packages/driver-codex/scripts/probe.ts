// 推論もスレッドの作成も行わない、手動の認証確認。
import { createCodexDriver } from '../src/index.ts';

const driver = createCodexDriver({ codexPath: process.argv[2] });
const auth = await driver.checkAuth();
process.stdout.write(JSON.stringify(auth) + '\n');
process.exitCode = auth.ok ? 0 : 1;
