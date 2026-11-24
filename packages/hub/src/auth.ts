// リクエストの利用者確認。
//
// Hub は 127.0.0.1 でだけ待ち受け、外からは `tailscale serve` が中継する。
// serve は tailnet のユーザーの端末からのリクエストに Tailscale-User-Login を付けるので、
// それが許可リスト（allowedUsers）に入っているかを確かめる。
// ヘッダーが無いリクエストは、Host が localhost / 127.0.0.1 のときだけ「このPCから直接」とみなす
// （serve 経由なら Host は *.ts.net になるので、タグ付き端末などヘッダーの無い serve 経由のアクセスは拒否される。
//  DNS リバインディングで別の Host 名を使った攻撃も、ここで拒否される）。

export interface AuthSettings {
  allowedUsers: string[];
  allowLocalhost: boolean;
}

export type AuthResult = { ok: true; user?: string } | { ok: false; status: 401 | 403; reason: string };

type Headers = Record<string, string | string[] | undefined>;

function header(h: Headers, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function hostnameOf(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0].toLowerCase();
}

export function checkRequest(headers: Headers, s: AuthSettings): AuthResult {
  const login = header(headers, 'tailscale-user-login');
  if (login) {
    const ok = s.allowedUsers.some((u) => u.toLowerCase() === login.toLowerCase());
    return ok ? { ok: true, user: login } : { ok: false, status: 403, reason: `${login} は許可されていません` };
  }
  const host = hostnameOf(header(headers, 'host'));
  if (s.allowLocalhost && LOCAL_HOSTS.has(host) && !header(headers, 'x-forwarded-for')) {
    return { ok: true };
  }
  return { ok: false, status: 401, reason: 'Tailscale のユーザーを確認できません（tailscale serve 経由で開いてください）' };
}

/**
 * 書き込み系の API（/api/ の GET・HEAD 以外）と WebSocket（/ws）は、PWA 自身のオリジンからだけ受け付ける。
 * Tailscale のヘッダーは端末ごとに付くので、ファイルビュワーで開いた HTML（サンドボックスで Origin は null）や
 * 別のサイトのページから Hub を操作されないよう、Origin を Host と比べる。
 * Origin の無いリクエスト（curl などブラウザ以外）は通す。ブラウザは POST などと WebSocket には必ず Origin を付ける。
 */
export function checkOrigin(method: string, url: string, headers: Headers): { ok: true } | { ok: false; reason: string } {
  const isWs = url === '/ws' || url.startsWith('/ws?') || url.startsWith('/ws/');
  const isWrite = url.startsWith('/api/') && method !== 'GET' && method !== 'HEAD';
  if (!isWs && !isWrite) return { ok: true };
  const origin = header(headers, 'origin');
  if (origin === undefined) return { ok: true };
  const deny = { ok: false as const, reason: `このページからは操作できません（Origin: ${origin}）` };
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return deny; // 'null'（サンドボックスの iframe など）もここで拒否する
  }
  // tailscale serve と開発時の Vite の中継は Host をそのまま渡すので、ページのオリジンと Host は一致する
  return host === (header(headers, 'host') ?? '').toLowerCase() ? { ok: true } : deny;
}
