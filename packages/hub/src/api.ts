// Hub ⇔ Web の API で使う型（Web からは `import type` だけで参照する）。
// Driver との契約（@agentpwa/shared）とは別に、Hub が Web に見せる形をここで決める。
import type { AgentKind, AuthCheck, DriverEvent, EffortLevel, PermissionMode, SessionEvent, SessionStatus } from '@agentpwa/shared';

export type ApprovalRequest = Extract<DriverEvent, { type: 'approval_request' }> & { at: string };
export type QuestionRequest = Extract<DriverEvent, { type: 'question' }> & { at: string };
export type UsageInfo = Extract<DriverEvent, { type: 'usage' }>;

/**
 * 表示の優先順位（docs/architecture.md「表示の優先順位」）。
 * 1 許可待ち / 2 質問待ち / 3 完了・未読 / 4 実行中 / 5 アイドル・停止
 */
export type Rank = 1 | 2 | 3 | 4 | 5;

export interface SessionSummary {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  folderName: string;
  machine: string;
  /** 現在のモデルとエフォート（Driver が送る model の値。省略はエージェントの既定） */
  model?: string;
  effort?: EffortLevel;
  /** 現在の権限モード（Driver が送る permission_mode の値） */
  permissionMode: PermissionMode;
  status: SessionStatus;
  statusReason?: string;
  /** 今の状態になった時刻（待ち時間の表示と並べ替えに使う） */
  statusSince: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  readSeq: number;
  unread: boolean;
  rank: Rank;
  /** 再開できるか（resume_token を受け取っているか） */
  resumable: boolean;
  /** Driver のプロセスが動いているか */
  live: boolean;
  archived: boolean;
  /** 一覧に出す直近の動き（例: 'Edit src/api.ts'） */
  activity?: string;
  lastError?: string;
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: QuestionRequest[];
}

/** プロジェクト（作業フォルダ）。使う AI はプロジェクトごとに固定する */
export interface FolderEntry {
  name: string;
  path: string;
  agent: AgentKind;
  /** 「すべて自動」（full_auto）を許すか。省略時は false（Hub が読み込み時に補う） */
  allowFullAuto?: boolean;
  /** 新しいセッションの既定の権限モード。省略時は 'ask'（Hub が読み込み時に補う） */
  defaultPermissionMode?: PermissionMode;
}

export interface AgentInfo {
  auth: AuthCheck;
  /** 表示確認用のフェイク Driver で動いているか */
  fake: boolean;
}

export interface HubInfo {
  machine: string;
  /** Tailscale-User-Login（このPCから直接開いたときは undefined） */
  user?: string;
  folders: FolderEntry[];
  agents: Record<AgentKind, AgentInfo>;
  usage: Record<AgentKind, UsageInfo[]>;
  configPath: string;
  protocolVersion: number;
  /** 画面からプロジェクトを作ってよいルートフォルダ（設定ファイルの projectRoots）。空なら作れない */
  projectRoots: string[];
}

/** GET /api/fs/dirs?path= の応答。path を省くとルートフォルダの一覧を返す */
export interface DirListing {
  /** 見ているフォルダ（ルートの一覧のときは undefined） */
  path?: string;
  /** 一つ上のフォルダ。ルートフォルダそのものを見ているときは undefined（ルートの一覧に戻る） */
  parent?: string;
  entries: DirEntry[];
}

export interface DirEntry {
  name: string;
  path: string;
  /** すでにプロジェクトとして登録済みか */
  registered: boolean;
}

/**
 * POST /api/projects の本文。作ったプロジェクトは設定ファイルの folders に書き足す。
 * - existing: 既存のフォルダ（path）をそのまま登録する
 * - new: 親フォルダ（path）の下に folderName のフォルダを作って登録する。gitInit で git init もする
 */
export interface CreateProjectRequest {
  mode: 'existing' | 'new';
  path: string;
  folderName?: string;
  gitInit?: boolean;
  /** 表示名。省略時はフォルダ名 */
  name?: string;
  agent: AgentKind;
  allowFullAuto?: boolean;
  defaultPermissionMode?: PermissionMode;
}

export interface CreateSessionRequest {
  /** 省略時はプロジェクトの AI。指定してプロジェクトの AI と違えば 400 */
  agent?: AgentKind;
  /** 許可リストのフォルダのパス */
  cwd: string;
  /** モデルとエフォート。省略はエージェントの既定（実行中も set_model で変えられる） */
  model?: string;
  effort?: EffortLevel;
  /** 省略時はプロジェクトの既定（defaultPermissionMode、なければ 'ask'）。full_auto は許可したプロジェクトだけ */
  permissionMode?: PermissionMode;
  prompt?: string;
  title?: string;
}

/** PATCH /api/sessions/:id の本文。archived を変えるとき、動いているセッションは先に止める */
export interface UpdateSessionRequest {
  title?: string;
  archived?: boolean;
}

/** DELETE /api/sessions/:id の応答 */
export interface DeleteSessionResult {
  ok: true;
  /** エージェント側の履歴（deleteHistory）を消せなかったときの理由。Hub の記録は消えている */
  historyError?: string;
}

/** WebSocket で Hub から Web へ送るメッセージ */
export type ServerMessage =
  | { type: 'hello'; sessions: SessionSummary[]; info: HubInfo }
  | { type: 'session'; session: SessionSummary }
  /** セッションを削除したとき（各端末はペインを閉じ、件数を数え直す） */
  | { type: 'session_removed'; sessionId: string }
  | { type: 'event'; event: SessionEvent }
  | { type: 'usage'; agent: AgentKind; usage: UsageInfo[] }
  /** 設定ファイルが読み直されたとき */
  | { type: 'info'; info: HubInfo };
