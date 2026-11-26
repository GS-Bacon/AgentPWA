// Hub ⇔ Web の API で使う型（Web からは `import type` だけで参照する）。
// Driver との契約（@agentpwa/shared）とは別に、Hub が Web に見せる形をここで決める。
import type { AgentKind, AuthCheck, DriverEvent, EffortLevel, PermissionMode, SessionEvent, SessionStatus } from '@agentpwa/shared';

export type ApprovalRequest = Extract<DriverEvent, { type: 'approval_request' }> & { at: string };
export type QuestionRequest = Extract<DriverEvent, { type: 'question' }> & { at: string };
export type UsageInfo = Extract<DriverEvent, { type: 'usage' }>;

/**
 * 表示の優先順位（docs/architecture.md「表示の優先順位」）。
 * 1 許可待ち / 2 質問待ち / 3 完了・未読 / 4 実行中 / 5 あとで返信 / 6 アイドル・停止
 * 「あとで返信」の印（laterSince）があるものは、許可待ちを除いて 5 に入れる。
 * 一覧では、ピン止め（pinned）したものを順位にかかわらず先に出す。
 */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6;

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
  /** 「あとで返信」の印を付けた時刻（印が無ければ省略）。ユーザーが送信・回答すると外れる */
  laterSince?: string;
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
  /** 入力欄で # を打ったときに出す候補（例: 案件の記号 J01）。省略時は候補なし */
  tags?: ProjectTag[];
}

/** 入力欄の # の候補。選ぶと「#名前」が入力欄に入る */
export interface ProjectTag {
  /** # の後ろに入る名前（空白と # は使えない） */
  name: string;
  /** 候補の横に出す説明（任意） */
  description?: string;
}

/** プロジェクトに付けられる色（パレット）。実際の色は Web の PROJECT_COLOR_HEX で決める */
export type ProjectColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray';

/** AI ごとの既定のモデルとエフォート（設定ファイルの agentDefaults）。省いた項目は CLI の既定 */
export interface AgentDefaults {
  /** エイリアス（opus など）か正式名 */
  model?: string;
  effort?: EffortLevel;
}

/** PATCH /api/agent-defaults の本文。agent の既定を変える（null で外して CLI の既定に戻す。省いた項目は変えない） */
export interface UpdateAgentDefaultsRequest {
  agent: AgentKind;
  model?: string | null;
  effort?: EffortLevel | null;
}

/** PATCH /api/projects の本文。path のプロジェクトの設定（色と # の候補）を変える。省いた項目は変えない */
export interface UpdateProjectRequest {
  path: string;
  /** どの AI のプロジェクトか（同じフォルダを両方の AI で登録しているとき用。省くとそのフォルダの最初のプロジェクト） */
  agent?: AgentKind;
  /** 色（null で外す） */
  color?: ProjectColor | null;
  /** # の候補（空の配列か null で外す）。この順のまま保存する */
  tags?: ProjectTag[] | null;
}

/** GET /api/sessions/:id/mentions?q= の応答の1件（入力欄の @ の候補） */
export interface MentionItem {
  /** セッションの作業フォルダからの相対パス（区切りは /。フォルダは末尾に / を付ける） */
  path: string;
  kind: 'file' | 'dir';
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
  /** アクセスの許可（設定タブの「アクセス」） */
  access: AccessInfo;
  /** AI ごとの既定のモデルとエフォート（設定ファイルの agentDefaults）。新しいセッションで省いたときに使う */
  agentDefaults: Record<AgentKind, AgentDefaults>;
}

/** 許可されていないのに開こうとした Tailscale ユーザー（Hub のメモリだけに覚える） */
export interface PendingUser {
  /** Tailscale-User-Login */
  login: string;
  /** Tailscale-User-Name（表示名） */
  name?: string;
  /** 最後に開こうとした時刻 */
  lastSeen: string;
}

export interface AccessInfo {
  /** 許可している Tailscale ユーザー（設定ファイルの allowedUsers） */
  allowedUsers: string[];
  /** 許可待ち（新しい順） */
  pending: PendingUser[];
}

/** POST /api/access/allow・/api/access/revoke・/api/access/dismiss の本文。応答は AccessInfo */
export interface AccessRequest {
  login: string;
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
  /** モデルとエフォート。省略は設定の既定（agentDefaults）、それも無ければエージェント（CLI）の既定。実行中も set_model で変えられる */
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
  /** true で「あとで返信」の印を付ける（既読にもする）、false で外す */
  later?: boolean;
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
