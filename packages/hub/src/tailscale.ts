// このPCの Tailscale の状態を tailscale CLI から読む（自動設定とセットアップで使う）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TailscaleStatus {
  /** tailscale が動いていて tailnet につながっているか（BackendState が Running） */
  running: boolean;
  /** このPCにログインしている Tailscale ユーザー（Tailscale-User-Login と同じ形。例: you@example.com） */
  login?: string;
  /** このPCの MagicDNS 名（末尾の . は除く。例: pc.tail1234.ts.net） */
  dnsName?: string;
}

/** tailscale CLI の場所。PATH に無ければ、標準のインストール先を探す */
export function findTailscale(): string {
  const candidates =
    process.platform === 'win32'
      ? [`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`]
      : process.platform === 'darwin'
        ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']
        : [];
  return candidates.find((c) => fs.existsSync(c)) ?? 'tailscale';
}

/** tailscale status --json の中身から、使う値だけを取り出す */
export function parseStatus(json: unknown): TailscaleStatus {
  const j = (json ?? {}) as {
    BackendState?: string;
    Self?: { UserID?: number; DNSName?: string };
    User?: Record<string, { LoginName?: string }>;
  };
  const uid = j.Self?.UserID;
  const login = uid !== undefined ? j.User?.[String(uid)]?.LoginName : undefined;
  const dnsName = j.Self?.DNSName?.replace(/\.$/, '') || undefined;
  return { running: j.BackendState === 'Running', login: login || undefined, dnsName };
}

/** Tailscale の状態。CLI が無い・動いていないときは undefined */
export async function tailscaleStatus(bin = findTailscale()): Promise<TailscaleStatus | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ['status', '--json'], { windowsHide: true, timeout: 10_000 });
    return parseStatus(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}
