// プロジェクト（作業フォルダ）ごとにセッションをまとめる。
// プロジェクトは Hub の設定ファイルの folders の順に並べ、使う AI はプロジェクトごとに固定（folders の agent）。
// 設定から外れたフォルダのセッションは、最後に「登録外」としてまとめる。
// アーカイブしたセッションはプロジェクトに入れず、一覧の末尾の「アーカイブ済み」にまとめる（archivedSessions）。
import type { AgentKind } from '@agentpwa/shared';
import type { FolderEntry, HubInfo, SessionSummary } from '@agentpwa/hub/api';
import { sortedSessions } from './store.ts';

export interface Project {
  /** パスを小文字にしたもの（URL やペインの記憶に使う） */
  key: string;
  name: string;
  path: string;
  /** このプロジェクトで使う AI */
  agent: AgentKind;
  /** 設定ファイルの folders に入っているか（入っていなければ新しいセッションは始められない） */
  registered: boolean;
  /** 優先順位で並べ替え済み */
  sessions: SessionSummary[];
  /** あなたの番（許可待ち・質問・完了未読）の件数 */
  waiting: number;
  /** 最後に動いた時刻 */
  updatedAt?: string;
}

export function projectKey(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase();
}

export function buildProjects(info: HubInfo | null, sessions: Record<string, SessionSummary>): Project[] {
  const map = new Map<string, Project>();
  for (const f of info?.folders ?? []) {
    const key = projectKey(f.path);
    map.set(key, { key, name: f.name, path: f.path, agent: f.agent, registered: true, sessions: [], waiting: 0 });
  }
  const extra: Project[] = [];
  for (const s of sortedSessions(sessions)) {
    const key = projectKey(s.cwd);
    let p = map.get(key);
    if (!p) {
      p = { key, name: s.folderName || s.cwd, path: s.cwd, agent: s.agent, registered: false, sessions: [], waiting: 0 };
      map.set(key, p);
      extra.push(p);
    }
    if (!p.updatedAt || s.updatedAt > p.updatedAt) p.updatedAt = s.updatedAt;
    p.sessions.push(s);
    if (s.rank <= 3) p.waiting++;
  }
  const registered = [...map.values()].filter((p) => p.registered);
  extra.sort((a, b) => a.name.localeCompare(b.name));
  return [...registered, ...extra];
}

/** アーカイブ済みのセッション（最近動いた順）。projectKey を渡すとそのプロジェクトのものだけ */
export function archivedSessions(sessions: Record<string, SessionSummary>, key?: string): SessionSummary[] {
  return Object.values(sessions)
    .filter((s) => s.archived && (!key || projectKey(s.cwd) === key))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** セッションのフォルダの設定（許可リストの項目）。外れていれば undefined */
export function folderOf(info: HubInfo | null, cwd: string): FolderEntry | undefined {
  const key = projectKey(cwd);
  return info?.folders.find((f) => projectKey(f.path) === key);
}

/** このフォルダで「すべて自動」を選べるか（最終的な判定は Hub がする） */
export function fullAutoAllowed(info: HubInfo | null, cwd: string): boolean {
  return folderOf(info, cwd)?.allowFullAuto === true;
}

export function findProject(projects: Project[], key: string): Project | undefined {
  return projects.find((p) => p.key === key);
}
