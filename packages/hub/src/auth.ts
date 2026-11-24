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
