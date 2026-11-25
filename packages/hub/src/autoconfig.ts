// 設定ファイルの自動設定。Hub の起動時と `npm run setup` で、空の項目を分かる範囲で埋める。
// - allowedUsers が空なら、このPCにログインしている Tailscale ユーザーを入れる（このPCの持ち主とみなす）
// - 設定ファイルを新しく作ったときは、projectRoots にホームフォルダを入れる（画面からプロジェクトを作れるように）
// すでに書かれている値は変えない。
import os from 'node:os';
import type { TailscaleStatus } from './tailscale.ts';
import { tailscaleStatus } from './tailscale.ts';
import { editConfig } from './projects.ts';

export interface AutoFillResult {
  /** 自動で入れた項目の説明（ログと画面に出す） */
  changes: string[];
}

export interface AutoFillOptions {
  /** 設定ファイルを今回作ったか */
  created: boolean;
  /** テスト用。省略時は tailscale CLI に聞く */
  tailscale?: () => Promise<TailscaleStatus | undefined>;
  homeDir?: string;
}

export async function autoFillConfig(configPath: string, opts: AutoFillOptions): Promise<AutoFillResult> {
  const changes: string[] = [];
  const ts = await (opts.tailscale ?? (() => tailscaleStatus()))();
  await editConfig(configPath, (raw) => {
    const users = Array.isArray(raw.allowedUsers) ? raw.allowedUsers : [];
    if (users.length === 0 && ts?.login) {
      raw.allowedUsers = [ts.login];
      changes.push(`allowedUsers に、このPCの Tailscale ユーザー ${ts.login} を入れました`);
    }
    const roots = Array.isArray(raw.projectRoots) ? raw.projectRoots : [];
    if (opts.created && roots.length === 0) {
      const home = opts.homeDir ?? os.homedir();
      raw.projectRoots = [home];
      changes.push(`projectRoots にホームフォルダ ${home} を入れました（この下のフォルダを画面からプロジェクトにできます）`);
    }
    return changes.length > 0;
  });
  return { changes };
}
