// 初回セットアップ（npm run setup）。対話しながら、できるところは自動で設定する。
//   1. 必要なもの（Node.js、claude CLI とログイン、Tailscale）を確かめる
//   2. 設定ファイルを作り、Tailscale のユーザーとホームフォルダを自動で入れる
//   3. Web をビルドする
//   4. tailscale serve で tailnet の中に公開する（確認してから）
//   5. ログオン時に Hub を自動で起動する（Windows。確認してから）
// 何度実行してもよい（済んでいる手順は飛ばす）。--yes で、確認にすべて「はい」と答える。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClaudeDriver } from '@agentpwa/driver-claude';
import { autoFillConfig } from './autoconfig.ts';
import { loadConfig } from './config.ts';
import { findTailscale, tailscaleStatus } from './tailscale.ts';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const yes = process.argv.includes('--yes') || process.argv.includes('-y');
const interactive = process.stdin.isTTY && !yes;

const ok = (s: string) => console.log(`  ✓ ${s}`);
const warn = (s: string) => console.log(`  ! ${s}`);
const info = (s: string) => console.log(`    ${s}`);
const step = (n: number, s: string) => console.log(`\n[${n}/5] ${s}`);

let rl: ReturnType<typeof createInterface> | undefined;
/** はい・いいえで聞く。--yes なら「はい」。対話できないときは「いいえ」（公開や自動起動を勝手に行わない） */
async function confirm(q: string, def: boolean): Promise<boolean> {
  if (yes) return true;
  if (!interactive) {
    info(`${q} → 対話できないので飛ばします（npm run setup -- --yes で「はい」と答えます）`);
    return false;
  }
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ? ${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return a === '' ? def : a === 'y' || a === 'yes' || a === 'はい';
}

/** コマンドを、出力をそのまま見せながら実行する */
function run(cmd: string, args: string[], cwd = repoRoot): Promise<number> {
  return new Promise((resolve) => {
    // Windows の npm は npm.cmd なので shell を通す（引数は固定の値だけなので、つないで1つのコマンドにする）
    const p =
      process.platform === 'win32' && cmd === 'npm'
        ? spawn([cmd, ...args].join(' '), { cwd, stdio: 'inherit', shell: true })
        : spawn(cmd, args, { cwd, stdio: 'inherit' });
    p.on('error', () => resolve(-1));
    p.on('exit', (code) => resolve(code ?? -1));
  });
}

function nodeVersionOk(): boolean {
  // node:sqlite をフラグなしで使えるのは 22.13 から
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** Hub がもう動いているか（このPCから直接たずねる） */
async function hubRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Windows のスタートアップフォルダに置く、Hub を起動するスクリプト */
function startupScriptPath(): string | undefined {
  if (process.platform !== 'win32' || !process.env.APPDATA) return undefined;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AgentPWA Hub.cmd');
}

function startupScript(repo: string, log: string): string {
  // 最小化したウィンドウで npm start を動かす（ウィンドウを閉じると Hub が止まる）。出力はログファイルへ
  return ['@echo off', 'rem AgentPWA の Hub をログオン時に起動する（npm run setup が作成）', `cd /d "${repo}"`, `start "AgentPWA Hub" /min cmd /c "npm start >> "${log}" 2>&1"`, ''].join('\r\n');
}

async function main(): Promise<void> {
  console.log('AgentPWA のセットアップ');
  let problems = 0;

  // ---- 1. 必要なもの ----
  step(1, '必要なものを確かめます');
  if (nodeVersionOk()) ok(`Node.js ${process.versions.node}`);
  else {
    warn(`Node.js ${process.versions.node} は古すぎます。22.13 以上（現行の LTS）を入れてください: https://nodejs.org/`);
    problems++;
  }

  const loaded = loadConfig();
  const auth = await createClaudeDriver({ claudePath: loaded.config.claudePath }).checkAuth();
  if (auth.ok) ok(`claude CLI${auth.version ? ` ${auth.version}` : ''}（${auth.detail ?? 'ログイン済み'}）`);
  else {
    warn(`claude CLI を使えません: ${auth.detail ?? '見つかりません'}`);
    info('Claude Code を入れて、ターミナルで claude を起動してログインしてください（Pro / Max / Team のサブスクリプション）。');
    info('https://docs.claude.com/claude-code');
    problems++;
  }

  const tsBin = findTailscale();
  const ts = await tailscaleStatus(tsBin);
  if (ts?.running) ok(`Tailscale（${ts.login ?? 'ユーザー不明'} · ${ts.dnsName ?? '名前不明'}）`);
  else if (ts) {
    warn('Tailscale が tailnet につながっていません。Tailscale を起動してログインしてください。');
    problems++;
  } else {
    warn('Tailscale が見つかりません。iPhone などから開くには、このPCと端末に Tailscale を入れて同じ tailnet にログインしてください: https://tailscale.com/download');
    info('このPCのブラウザだけで使うなら、Tailscale は無くてもかまいません（http://127.0.0.1:8787）。');
  }

  // ---- 2. 設定ファイル ----
  step(2, '設定ファイルを用意します');
  if (loaded.created) ok(`作りました: ${loaded.path}`);
  else ok(`あります: ${loaded.path}`);
  const filled = await autoFillConfig(loaded.path, { created: loaded.created, tailscale: async () => ts });
  for (const c of filled.changes) ok(c);
  const { config } = loadConfig(loaded.path);
  info(`マシン名: ${config.machineName}`);
  info(`許可するユーザー（allowedUsers）: ${config.allowedUsers.join(', ') || '（なし）'}`);
  info(`プロジェクトを作れる場所（projectRoots）: ${config.projectRoots.join(', ') || '（なし）'}`);
  if (config.allowedUsers.length === 0) {
    info('ほかの人や端末は、開こうとしたあとに、このPCのブラウザの「設定 → アクセス」から許可できます。');
  }

  // ---- 3. ビルド ----
  step(3, 'Web をビルドします');
  if ((await run('npm', ['run', 'build'])) === 0) ok('ビルドしました');
  else {
    warn('ビルドに失敗しました。上のエラーを確かめてください。');
    problems++;
  }

  // ---- 4. tailscale serve ----
  step(4, 'tailnet の中に公開します（tailscale serve）');
  let url: string | undefined;
  if (!ts?.running) {
    warn('Tailscale が使えないので飛ばします。あとで npm run setup をもう一度実行してください。');
  } else {
    url = ts.dnsName ? `https://${ts.dnsName}/` : undefined;
    let served = false;
    try {
      const { stdout } = await execFileAsync(tsBin, ['serve', 'status', '--json'], { windowsHide: true, timeout: 10_000 });
      served = new RegExp(`(127\\.0\\.0\\.1|localhost):${config.port}\\b`).test(stdout);
    } catch {
      /* 未設定 */
    }
    if (served) ok(`公開済みです: ${url ?? ''}`);
    else {
      info(`このPCの Hub（127.0.0.1:${config.port}）を、tailnet の中の端末からだけ HTTPS で開けるようにします（インターネットには公開しません）。`);
      if (await confirm('tailscale serve を設定しますか？', true)) {
        info('HTTPS 証明書が有効になっていないと、有効にするための URL が出ます。ブラウザで開いて有効にすると続きます。');
        if ((await run(tsBin, ['serve', '--bg', String(config.port)])) === 0) ok(`公開しました: ${url ?? ''}`);
        else {
          warn('tailscale serve に失敗しました。Tailscale の管理画面で MagicDNS と HTTPS 証明書を有効にしてから、もう一度実行してください。');
          problems++;
        }
      } else info(`あとで設定するときは: tailscale serve --bg ${config.port}`);
    }
  }

  // ---- 5. 自動起動 ----
  step(5, 'ログオン時に Hub を自動で起動します');
  const startup = startupScriptPath();
  if (!startup) {
    info('Windows 以外では自動では設定しません。launchd（macOS）や systemd（Linux）で、このフォルダの npm start を起動してください。');
  } else if (fs.existsSync(startup)) {
    ok(`設定済みです: ${startup}`);
  } else if (await confirm('ログオン時に Hub を自動で起動しますか？（スタートアップに登録します）', true)) {
    const log = path.join(config.dataDir, 'hub.log');
    fs.writeFileSync(startup, startupScript(repoRoot, log));
    ok(`登録しました: ${startup}`);
    info(`ログ: ${log}（やめるときはこのファイルを消します）`);
  }

  // ---- 起動 ----
  if (await hubRunning(config.port)) {
    ok(`Hub は動いています（http://127.0.0.1:${config.port}）。設定の変更は自動で読み直されます。`);
  } else if (startup && fs.existsSync(startup) && (await confirm('いま Hub を起動しますか？', true))) {
    await run('cmd', ['/c', startup]);
    ok('起動しました（最小化したウィンドウ「AgentPWA Hub」）。');
  } else {
    info('Hub を起動するには: npm start');
  }

  console.log('');
  if (problems > 0) console.log(`! ${problems} 件の問題があります。上の「!」の行を直してから、もう一度 npm run setup を実行してください。`);
  else console.log('セットアップが終わりました。');
  console.log(`  このPCから:     http://127.0.0.1:${config.port}/`);
  if (url) {
    console.log(`  iPhone / iPad: ${url}`);
    console.log('    （Tailscale を入れた端末の Safari で開き、共有メニューの「ホーム画面に追加」でアプリとして使えます）');
  }
  rl?.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  rl?.close();
  process.exit(1);
});
