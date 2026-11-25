// アクセスの許可（設定ファイルの allowedUsers）を画面から行う。
//
// allowedUsers に入っていない Tailscale ユーザーが開こうとしたら、そのユーザーを「許可待ち」として覚える
// （Hub のメモリだけ。再起動で消える）。すでに許可されたユーザーか、このPCから直接開いた人が、
// 設定タブで許可すると allowedUsers に書き足す。許可されたユーザーは Hub を通じてこのPCで AI を動かせるので、
// 許可できるのも同じ権限を持つ人だけにする（許可されていない人はそもそも API に届かない）。
import type { AccessInfo, PendingUser } from './api.ts';
import type { HubConfig } from './config.ts';
import { editConfig } from './projects.ts';
import { HttpError } from './sessions.ts';

/** 覚えておく許可待ちのユーザーの数（古いものから消す） */
const MAX_PENDING = 20;
/** Tailscale のログイン名として受け付ける形 */
const LOGIN_RE = /^[^\s<>"'`]{1,254}$/;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class AccessRequests {
  private pending = new Map<string, PendingUser>();

  /** 許可されていないユーザーからのアクセスを覚える。新しいユーザーなら true（各端末に知らせる） */
  record(login: string, name?: string): boolean {
    if (!LOGIN_RE.test(login)) return false;
    const key = login.toLowerCase();
    const prev = this.pending.get(key);
    this.pending.delete(key); // 新しい順に並べ直す
    this.pending.set(key, { login, name: name || prev?.name, lastSeen: new Date().toISOString() });
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    return !prev;
  }

  forget(login: string): boolean {
    return this.pending.delete(login.toLowerCase());
  }

  /** 新しい順 */
  list(): PendingUser[] {
    return [...this.pending.values()].reverse();
  }
}

export interface AccessDeps {
  config: HubConfig;
  configPath: string;
  requests: AccessRequests;
  onChanged: () => void;
}

export function accessInfo(deps: AccessDeps): AccessInfo {
  return { allowedUsers: deps.config.allowedUsers, pending: deps.requests.list() };
}

function parseLogin(v: unknown): string {
  if (typeof v !== 'string' || !LOGIN_RE.test(v.trim())) throw new HttpError(400, 'Tailscale のログイン名が正しくありません');
  return v.trim();
}

/** ユーザーを許可する（allowedUsers に書き足す） */
export async function allowUser(deps: AccessDeps, body: unknown): Promise<AccessInfo> {
  const login = parseLogin((body as { login?: unknown } | undefined)?.login);
  await editConfig(deps.configPath, (raw) => {
    const users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as unknown[]) : [];
    if (users.some((u) => typeof u === 'string' && same(u, login))) return false;
    raw.allowedUsers = [...users, login];
    return true;
  });
  // 監視による読み直しを待たずに反映する
  if (!deps.config.allowedUsers.some((u) => same(u, login))) deps.config.allowedUsers = [...deps.config.allowedUsers, login];
  deps.requests.forget(login);
  deps.onChanged();
  return accessInfo(deps);
}

/** 許可を取り消す（allowedUsers から消す）。自分自身は取り消せない（この端末から操作できなくなるため） */
export async function revokeUser(deps: AccessDeps, body: unknown, self?: string): Promise<AccessInfo> {
  const login = parseLogin((body as { login?: unknown } | undefined)?.login);
  if (self && same(self, login)) throw new HttpError(400, '自分自身の許可は取り消せません（このPCから直接開くか、設定ファイルを編集してください）');
  await editConfig(deps.configPath, (raw) => {
    const users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as unknown[]) : [];
    const next = users.filter((u) => !(typeof u === 'string' && same(u, login)));
    if (next.length === users.length) return false;
    raw.allowedUsers = next;
    return true;
  });
  deps.config.allowedUsers = deps.config.allowedUsers.filter((u) => !same(u, login));
  deps.onChanged();
  return accessInfo(deps);
}

/** 許可待ちの一覧から消す（許可はしない） */
export function dismissUser(deps: AccessDeps, body: unknown): AccessInfo {
  const login = parseLogin((body as { login?: unknown } | undefined)?.login);
  if (deps.requests.forget(login)) deps.onChanged();
  return accessInfo(deps);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 許可されていないときにブラウザに見せるページ（PWA を入れる前の最初のアクセスなど） */
export function deniedPage(status: 401 | 403, reason: string, login?: string): string {
  const what =
    status === 403 && login
      ? `<p><b>${escapeHtml(login)}</b> は、まだこの Hub の利用を許可されていません。</p>
<p>この Hub を動かしている PC で、すでに許可されている端末から AgentPWA を開くか、その PC のブラウザで <code>http://127.0.0.1:&lt;ポート&gt;/</code>（既定は 8787）を開き、<b>設定 → アクセス</b> の「許可待ち」から許可してください。許可されると、この画面は自動で開き直します。</p>`
      : `<p>${escapeHtml(reason)}</p>
<p>Tailscale の <code>tailscale serve</code> で公開した URL（<code>https://&lt;PC名&gt;.&lt;tailnet名&gt;.ts.net/</code>）から開いてください。この端末が tailnet に入っていて、Tailscale のユーザーでログインしている必要があります。</p>`;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPWA — 許可されていません</title>
<style>body{margin:0;padding:32px 20px;background:#0d1117;color:#e6edf3;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif}
main{max-width:560px;margin:0 auto}h1{font-size:20px;font-weight:600;margin:0 0 16px}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:1px 5px}
p{color:#e6edf3}.muted{color:#9198a1;font-size:13px}</style></head>
<body><main><h1>AgentPWA を開けません</h1>${what}
<p class="muted">${status} · ${escapeHtml(reason)}</p></main>
${status === 403 ? '<script>setInterval(()=>fetch("/api/info",{cache:"no-store"}).then(r=>{if(r.ok)location.reload()}).catch(()=>{}),5000)</script>' : ''}
</body></html>`;
}
