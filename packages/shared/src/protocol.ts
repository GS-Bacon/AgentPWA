/**
 * AgentPWA 共通プロトコル — Hub / Driver / Web の契約
 *
 * このファイルは Claude 担当と Codex 担当の「境界」です。
 * - 片方の都合だけで変更しないこと。変更は docs/protocol.md の「変更履歴」に追記し、
 *   互換性を壊す変更では PROTOCOL_VERSION を上げる。
 * - 各 Driver は自分のエージェント固有の情報を、ここで定義した形に正規化して Hub に渡す。
 *   Hub と Web はエージェントの違いを知らなくても動くことを目標にする。
 */

export const PROTOCOL_VERSION = 1;

/** エージェントの種類。UI ではタブ（Claude / Codex）の切り分けに使う。 */
export type AgentKind = 'claude' | 'codex';

/**
 * セッションの状態（Driver が報告する）。
 * 「完了・未読」は Driver ではなく Hub が既読管理から導出する（idle + 未読）。
 */
export type SessionStatus =
  | 'starting' // プロセス起動中・接続中
  | 'running' // エージェントが作業中
  | 'waiting_approval' // コマンド実行・ファイル変更などの許可／承認待ち
  | 'waiting_input' // エージェントからユーザーへの質問待ち
  | 'idle' // ターン完了。次の指示を待っている
  | 'error' // 復帰可能なエラーで止まっている
  | 'stopped'; // 終了済み（再開には resumeToken を使う）

/** 一覧で「あなたの番」に入る状態（優先表示の対象）。idle は未読のときだけ Hub が加える。 */
export const USER_TURN_STATUSES: readonly SessionStatus[] = ['waiting_approval', 'waiting_input'];

/** 権限モード。各 Driver がエージェント固有の設定に対応付ける。 */
export type PermissionMode =
  | 'ask' // 毎回確認（既定）
  | 'auto_edit' // ファイル編集は自動、コマンドは確認
  | 'plan'; // 計画のみ（変更しない）

export interface StartOptions {
  /** Hub が採番する ID。Driver はこれをそのまま使う。 */
  sessionId: string;
  /** 作業フォルダ（Hub 側で許可リストに入っていることを確認済み）。 */
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  initialPrompt?: string;
  /** 再開用。Driver が以前 `resume_token` イベントで返した値。 */
  resumeToken?: string;
}

/**
 * 認証状態の確認結果。
 * このアプリはサブスクリプション（Claude Pro/Max、ChatGPT プラン）での利用が前提。
 * API キー（従量課金）で動きそうなときは auth: 'api_key' を返し、Hub は起動を拒否する。
 */
export interface AuthCheck {
  ok: boolean;
  /** CLI のバージョンなど */
  version?: string;
  auth: 'subscription' | 'api_key' | 'none' | 'unknown';
  /** UI に出す説明（例: 「ANTHROPIC_API_KEY が設定されています」） */
  detail?: string;
}

export type ApprovalKind = 'command' | 'file_change' | 'permission' | 'other';

export type ApprovalDecision =
  | 'allow' // 今回だけ許可
  | 'allow_session' // このセッション中は同種の操作を許可
  | 'deny'; // 拒否（note があればエージェントへの指示として渡す）

export interface FileChange {
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'rename';
  additions?: number;
  deletions?: number;
  /** unified diff。大きすぎる場合は省略してよい。 */
  diff?: string;
}

/** Driver → Hub のイベント。Hub が sessionId / seq / at を付けて保存・配信する。 */
export type DriverEvent =
  | { type: 'status'; status: SessionStatus; reason?: string }
  /** アシスタント発話のストリーミング断片。最後に同じ messageId の `message` を送ること。 */
  | { type: 'message_delta'; messageId: string; text: string }
  | { type: 'message'; messageId: string; role: 'user' | 'assistant'; text: string }
  | {
      type: 'tool';
      toolId: string;
      /** 例: 'Bash', 'Edit', 'Read'（エージェント固有名のままでよい） */
      name: string;
      /** 一行要約。例: 'npm test -- api' / 'src/api.ts +6 −4' */
      summary: string;
      state: 'running' | 'done' | 'failed';
      output?: string;
    }
  | {
      type: 'approval_request';
      requestId: string;
      kind: ApprovalKind;
      /** 例: 'コマンドを実行してよいですか？' */
      title: string;
      command?: string;
      cwd?: string;
      changes?: FileChange[];
      /** このリクエストで選べる決定。allow_session が無いエージェントもある。 */
      choices: ApprovalDecision[];
    }
  | { type: 'approval_resolved'; requestId: string; decision: ApprovalDecision }
  | { type: 'question'; requestId: string; prompt: string; options?: string[] }
  | { type: 'question_resolved'; requestId: string }
  /** 再開に必要なエージェント固有 ID（Claude の session_id、Codex の thread.id など）。分かった時点ですぐ送る。 */
  | { type: 'resume_token'; token: string }
  | { type: 'usage'; label: string; percent?: number; resetsAt?: string }
  | { type: 'error'; message: string; fatal: boolean };

/** Hub が保存・配信するときの形。 */
export type SessionEvent = DriverEvent & {
  sessionId: string;
  /** セッション内の通し番号。再接続時の差分取得に使う。 */
  seq: number;
  /** ISO 8601 */
  at: string;
};

/** Hub → Driver の操作。 */
export type UserAction =
  | { type: 'send'; text: string }
  | { type: 'approve'; requestId: string; decision: ApprovalDecision; note?: string }
  | { type: 'answer'; requestId: string; text: string }
  | { type: 'interrupt' };

/** 各 Driver パッケージが実装するインターフェース。 */
export interface AgentDriver {
  readonly kind: AgentKind;
  /** CLI の有無と認証方式を確認する。起動前に Hub が必ず呼ぶ。 */
  checkAuth(): Promise<AuthCheck>;
  /** セッションを開始（または resumeToken で再開）する。emit は何度呼んでもよい。 */
  start(opts: StartOptions, emit: (event: DriverEvent) => void): Promise<DriverSession>;
}

export interface DriverSession {
  send(action: UserAction): Promise<void>;
  /** プロセスを終了する。終了後に status: 'stopped' を emit すること。 */
  stop(): Promise<void>;
}
