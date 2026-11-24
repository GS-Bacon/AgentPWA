// Hub ⇔ Web の API で使う型（Web からは `import type` だけで参照する）。
// Driver との契約（@agentpwa/shared）とは別に、Hub が Web に見せる形をここで決める。
import type { AgentKind, AuthCheck, DriverEvent, EffortLevel, PermissionMode, SessionEvent, SessionStatus } from '@agentpwa/shared';

export type ApprovalRequest = Extract<DriverEvent, { type: 'approval_request' }> & { at: string };
export type QuestionRequest = Extract<DriverEvent, { type: 'question' }> & { at: string };
export type UsageInfo = Extract<DriverEvent, { type: 'usage' }>;

/**
 * 表示の優先順位（docs/architecture.md「表示の優先順位」）。
 * 1 許可待ち / 2 質問待ち / 3 完了・未読 / 4 実行中 / 5 アイドル・停止
 * 一覧では、ピン止め（pinned）したものを順位にかかわらず先に出す。
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
  /** 既定やエイリアスを解決した実際のモデルとエフォート（例: claude-opus-5-5 / medium）。Driver が分かったときだけ */
  resolvedModel?: string;
  resolvedEffort?: EffortLevel;
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
  /** 未読か（ターンが終わってまだ読んでいないか、「未読にする」で印を付けた） */
  unread: boolean;
  /** 「未読にする」で付けた印があるか（開いて既読にすると外れる） */
  markedUnread: boolean;
  /** ピン止め（一覧の先頭に出す） */
  pinned: boolean;
  rank: Rank;
  /** 再開できるか（resume_token を受け取っているか） */
  resumable: boolean;
  /** Driver のプロセスが動いているか */
  live: boolean;
  archived: boolean;
  /** 何も書き込まれていない（空の）セッションか。空のまま画面で閉じると Hub が消す */
  empty: boolean;
  /** このセッションを作った AI のセッション（AI が Hub の API で作ったときだけ）。Web はこれを見て自動で開く */
  parentSessionId?: string;
  /** コンテキストの使用量（Driver が送る context の値）。windowTokens は上限が分かったときだけ */
  context?: { usedTokens: number; windowTokens?: number };
  /** 一覧に出す直近の動き（例: 'Edit src/api.ts'） */
  activity?: string;
  lastError?: string;
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: QuestionRequest[];
}

/**
 * プロジェクト（作業フォルダと AI の組）。使う AI はプロジェクトごとに固定する。
 * 同じフォルダを Claude と Codex の両方のプロジェクトとして登録できる（フォルダと AI の組で1つ）
 */
export interface FolderEntry {
  name: string;
  path: string;
  agent: AgentKind;
  /** 「すべて自動」（full_auto）を許すか。省略時は false（Hub が読み込み時に補う） */
  allowFullAuto?: boolean;
  /** 新しいセッションの既定の権限モード。省略時は 'auto'（DEFAULT_PERMISSION_MODE。Hub が読み込み時に補う） */
  defaultPermissionMode?: PermissionMode;
  /** プロジェクトの色（パレットの名前）。ペインの上部などを塗って見分けやすくする。省略時は色なし */
  color?: ProjectColor;
}

/** プロジェクトに付けられる色（パレット）。実際の色は Web の PROJECT_COLOR_HEX で決める */
export type ProjectColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray';

/** PATCH /api/projects の本文。path のプロジェクトの設定を変える（いまは色だけ。null で色を外す） */
export interface UpdateProjectRequest {
  path: string;
  /** どの AI のプロジェクトか（同じフォルダを両方の AI で登録しているとき用。省くとそのフォルダの最初のプロジェクト） */
  agent?: AgentKind;
  color: ProjectColor | null;
}

export interface AgentInfo {
  auth: AuthCheck;
  /** 表示確認用のフェイク Driver で動いているか */
  fake: boolean;
  /** ファイルを添付できるか（Driver の supportsAttachments） */
  attachments: boolean;
  /** スラッシュコマンドの一覧を出せるか（Driver の listCommands） */
  commands: boolean;
  /** 送った発言まで巻き戻せるか（Driver の supportsRewind。v11） */
  rewind: boolean;
  /** 送った発言からフォークできるか（Driver の forkToken。v11） */
  fork: boolean;
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

/** ファイルビュワーでの表示のしかた（docs/architecture.md の 5.1） */
export type FileKind = 'html' | 'image' | 'pdf' | 'media' | 'markdown' | 'text' | 'binary';

/** GET /api/sessions/:id/file-info?path= の応答。中身は GET /files/<セッションID>/<path> で取る */
export interface FileInfo {
  /** プロジェクトのフォルダからの相対パス（区切りは /） */
  path: string;
  size: number;
  mtime: string;
  kind: FileKind;
  mime: string;
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
  /** このフォルダをプロジェクトとして登録済みの AI（AI ごとに1つずつ登録できる。未登録なら空） */
  registeredAgents: AgentKind[];
}

/** PUT /api/projects/order の本文。登録済みのプロジェクト（フォルダと AI の組）を、すべて新しい順に並べる */
export interface ReorderProjectsRequest {
  projects: { path: string; agent: AgentKind }[];
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
  /**
   * どの AI のプロジェクトで始めるか（同じフォルダを両方の AI で登録しているとき用）。そのフォルダをこの AI で登録していなければ 403。
   * 省略時は、作成元のセッションと同じ AI のプロジェクトがあればそれ、なければそのフォルダの最初のプロジェクト
   */
  agent?: AgentKind;
  /** 許可リストのフォルダのパス（AI が作るときは省略でき、作成元のセッションと同じフォルダになる） */
  cwd: string;
  /** モデルとエフォート。省略はエージェントの既定（実行中も set_model で変えられる） */
  model?: string;
  effort?: EffortLevel;
  /** 省略時はプロジェクトの既定（defaultPermissionMode、なければ DEFAULT_PERMISSION_MODE = 'auto'）。full_auto は許可したプロジェクトだけ */
  permissionMode?: PermissionMode;
  prompt?: string;
  title?: string;
}

/** PATCH /api/sessions/:id の本文。archived を変えるとき、動いているセッションは先に止める */
export interface UpdateSessionRequest {
  title?: string;
  archived?: boolean;
  /** ピン止めする・外す */
  pinned?: boolean;
  /** true で「未読にする」（印を付ける）、false で既読にする（最新まで読んだことにする） */
  unread?: boolean;
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
