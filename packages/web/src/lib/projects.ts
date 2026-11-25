// プロジェクト（作業フォルダ）ごとにセッションをまとめる。
// プロジェクトは Hub の設定ファイルの folders の順に並べ、使う AI はプロジェクトごとに固定（folders の agent）。
// 同じフォルダを Claude と Codex の両方のプロジェクトとして登録できるので、プロジェクトはフォルダと AI の組で見分ける。
// 設定から外れたフォルダのセッションは、最後に「登録外」としてまとめる。
// アーカイブしたセッションはプロジェクトに入れず、一覧の末尾の「アーカイブ済み」にまとめる（archivedSessions）。
import type { AgentKind } from '@agentpwa/shared';
import type { FolderEntry, HubInfo, ProjectColor, ProjectTag, SessionSummary } from '@agentpwa/hub/api';
import { sortedSessions, useStore } from './store.ts';

export interface Project {
  /** AI とパス（小文字）の組（URL やペインの記憶に使う）。projectKey で作る */
  key: string;
  name: string;
  path: string;
  /** このプロジェクトで使う AI */
  agent: AgentKind;
  /** プロジェクトの色（設定ファイルの folders の color） */
  color?: ProjectColor;
  /** 設定ファイルの folders に入っているか（入っていなければ新しいセッションは始められない） */
  registered: boolean;
  /** 優先順位で並べ替え済み */
  sessions: SessionSummary[];
  /** あなたの番（許可待ち・質問・完了未読）の件数 */
  waiting: number;
  /** 最後に動いた時刻 */
  updatedAt?: string;
}

/** プロジェクト（フォルダと AI の組）を指すもの */
export interface ProjectRef {
  path: string;
  agent: AgentKind;
}

/** プロジェクト（フォルダと AI の組）のキー */
export function projectKey(path: string, agent: AgentKind): string {
  return `${agent}:${path.replace(/[\\/]+$/, '').toLowerCase()}`;
}

/** そのプロジェクトの項目か（パスの大文字・小文字と末尾の区切りは区別しない） */
export function isFolder(f: FolderEntry, path: string, agent: AgentKind): boolean {
  return projectKey(f.path, f.agent) === projectKey(path, agent);
}

export function buildProjects(info: HubInfo | null, sessions: Record<string, SessionSummary>): Project[] {
  const map = new Map<string, Project>();
  for (const f of info?.folders ?? []) {
    const key = projectKey(f.path, f.agent);
    map.set(key, { key, name: f.name, path: f.path, agent: f.agent, color: f.color, registered: true, sessions: [], waiting: 0 });
  }
  const extra: Project[] = [];
  for (const s of sortedSessions(sessions)) {
    const key = projectKey(s.cwd, s.agent);
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
    .filter((s) => s.archived && (!key || projectKey(s.cwd, s.agent) === key))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** セッションのプロジェクト（フォルダと AI の組）の設定（許可リストの項目）。外れていれば undefined */
export function folderOf(info: HubInfo | null, cwd: string, agent: AgentKind): FolderEntry | undefined {
  return info?.folders.find((f) => isFolder(f, cwd, agent));
}

/** セッションのプロジェクトの色。色が無いか、登録外なら undefined */
export function useProjectColor(s: { cwd: string; agent: AgentKind } | undefined): ProjectColor | undefined {
  return useStore((st) => (s ? folderOf(st.info, s.cwd, s.agent)?.color : undefined));
}

const NO_TAGS: ProjectTag[] = [];

/**
 * セッションの入力欄の # の候補。そのプロジェクトに無ければ、同じフォルダの別の AI のプロジェクトの候補を使う
 * （どのプロジェクトでも両方の AI のセッションを作れるので）
 */
export function projectTags(info: HubInfo | null, s: { cwd: string; agent: AgentKind }): ProjectTag[] {
  const own = folderOf(info, s.cwd, s.agent)?.tags;
  if (own?.length) return own;
  const other: AgentKind = s.agent === 'claude' ? 'codex' : 'claude';
  return folderOf(info, s.cwd, other)?.tags ?? NO_TAGS;
}

/** このセッションのプロジェクトで「すべて自動」を選べるか（最終的な判定は Hub がする） */
export function fullAutoAllowed(info: HubInfo | null, s: { cwd: string; agent: AgentKind }): boolean {
  return folderOf(info, s.cwd, s.agent)?.allowFullAuto === true;
}

export function findProject(projects: Project[], key: string): Project | undefined {
  return projects.find((p) => p.key === key);
}
