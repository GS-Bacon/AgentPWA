// 表示用の小さな関数
import { PERMISSION_MODES, type AgentKind, type PermissionMode } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
export const AGENT_COLOR: Record<AgentKind, string> = { claude: 'var(--claude)', codex: 'var(--codex)' };

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: '毎回確認',
  auto_edit: '編集は自動',
  auto: '自動承認',
  full_auto: 'すべて自動',
  plan: '計画のみ',
};

/** 権限モードの説明（メニューと新規セッションの画面で添える） */
export const MODE_NOTE: Partial<Record<PermissionMode, string>> = {
  auto: '安全と判定した操作は確認せずに実行します',
  full_auto: 'すべての操作を確認せずに実行します',
};

/** Shift+Tab で次に切り替えるモード（PERMISSION_MODES の順。確認が要る full_auto は巡回に入れない） */
export function nextCycleMode(current: PermissionMode): PermissionMode {
  const n = PERMISSION_MODES.length;
  const i = PERMISSION_MODES.indexOf(current);
  for (let k = 1; k <= n; k++) {
    const m = PERMISSION_MODES[(i + k + n) % n];
    if (m !== 'full_auto') return m;
  }
  return current;
}

export interface StatusView {
  label: string;
  cls: string;
}

export function statusView(s: SessionSummary): StatusView {
  switch (s.status) {
    case 'waiting_approval':
      return { label: s.agent === 'codex' ? '承認待ち' : '許可待ち', cls: 'st-approval' };
    case 'waiting_input':
      return { label: '質問', cls: 'st-question' };
    case 'idle':
      return s.unread ? { label: '完了・未読', cls: 'st-unread' } : { label: 'アイドル', cls: 'st-idle' };
    case 'running':
      return { label: '実行中', cls: 'st-running' };
    case 'starting':
      return { label: '起動中', cls: 'st-running' };
    case 'error':
      return { label: 'エラー', cls: 'st-error' };
    case 'stopped':
      return { label: '停止', cls: 'st-idle' };
  }
}

/** 経過時間（例: 4分 / 3時間 / 2日） */
export function elapsed(fromIso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間`;
  return `${Math.floor(h / 24)}日`;
}

/** 一覧の右側に出す時間表示 */
export function timeLabel(s: SessionSummary, now = Date.now()): string {
  if (s.rank <= 2) return elapsed(s.statusSince, now);
  if (s.rank === 3) return `${elapsed(s.statusSince, now)}前`;
  if (s.rank === 4) return elapsed(s.statusSince, now);
  return elapsed(s.updatedAt, now);
}

export function shortPath(p: string): string {
  return p.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~').replace(/^\/(home|Users)\/[^/]+/, '~');
}

/** セッションのフォルダの中のパスなら、フォルダからの相対パスにする（表示用） */
export function relPath(text: string, cwd: string): string {
  if (!cwd) return text;
  const norm = (s: string) => s.split('\\').join('/');
  const base = norm(cwd).replace(/\/+$/, '') + '/';
  const t = norm(text);
  const i = t.toLowerCase().indexOf(base.toLowerCase());
  if (i < 0) return text;
  return text.slice(0, i) + t.slice(i + base.length);
}

/** 実行中か（中断できる状態か）。入力欄の中断ボタンと Esc の中断で使う */
export function isRunning(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting' || s.status === 'waiting_approval' || s.status === 'waiting_input';
}
