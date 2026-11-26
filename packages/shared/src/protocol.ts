/**
 * AgentPWA 共通プロトコル — Hub / Driver / Web の契約
 *
 * このファイルは Claude 担当と Codex 担当の「境界」です。
 * - 片方の都合だけで変更しないこと。変更は docs/protocol.md の「変更履歴」に追記し、
 *   互換性を壊す変更では PROTOCOL_VERSION を上げる。
 * - 各 Driver は自分のエージェント固有の情報を、ここで定義した形に正規化して Hub に渡す。
 *   Hub と Web はエージェントの違いを知らなくても動くことを目標にする。
 */

export const PROTOCOL_VERSION = 13;

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

/**
 * 権限モード。各 Driver がエージェント固有の設定に対応付ける。
 * 起動時に StartOptions.permissionMode で決め、実行中も UserAction の set_permission_mode で変えられる。
 */
export type PermissionMode =
  | 'ask' // 毎回確認
  | 'auto_edit' // ファイル編集は自動、コマンドは確認
  | 'auto' // 自動承認。エージェント側の安全判定が許可を決め、危険と判定した操作だけ止める
  | 'full_auto' // すべて自動で許可（確認しない）。Hub がフォルダごとに許可した場合だけ使える
  | 'plan'; // 計画のみ（変更しない）

/** プロジェクトに既定の権限モードが無いときに使うモード（v7 で 'ask' から 'auto' に変更）。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/** UI での表示順（切り替えメニューの並び）。 */
export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto_edit', 'auto', 'full_auto', 'plan'];

/**
 * エフォート（考える深さ）。各 Driver がエージェント固有の設定に対応付ける。
 * 起動時に StartOptions.effort で決め、実行中も UserAction の set_model で変えられる。省略はエージェントの既定。
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** UI での表示順（低い順）。 */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface StartOptions {
  /** Hub が採番する ID。Driver はこれをそのまま使う。 */
  sessionId: string;
  /** 作業フォルダ（Hub 側で許可リストに入っていることを確認済み）。 */
  cwd: string;
  /** モデル（エイリアスか正式名）。省略はエージェントの既定 */
  model?: string;
  /** 省略はエージェントの既定 */
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  initialPrompt?: string;
  /** 再開用。Driver が以前 `resume_token` イベントで返した値。 */
  resumeToken?: string;
  /**
   * v13: Hub が AI に伝える説明（Markdown）。Hub の API の使い方（新しいセッションの作成、ほかのセッションへの
   * メッセージなど）と、このセッションの ID を含む。Driver は起動・再開のたびに、エージェントのシステムプロンプト
   * （開発者向けの指示）に足す。省略は「伝えることがない」（Hub の URL が分からないときなど）。
   */
  hubGuide?: string;
}

/**
 * v13: 別のセッションから届いたメッセージ（セッション間のメッセージ）の送り元。
 * Hub は送り元を先頭の段落に書いた `send` として、宛先のセッションの Driver に渡す。
 * Driver は特別な扱いをしない（ユーザーの発言と同じ）。Web は先頭の段落を見て「〇〇から」と表示する。
 */
export interface PeerMessageFrom {
  sessionId: string;
  title: string;
  agent: AgentKind;
}

const PEER_AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
const PEER_HEAD = /^\[AgentPWA\] セッション「([^\n]*)」（(Claude|Codex)、ID: ([A-Za-z0-9_-]+)）からのメッセージです。[^\n]*\n\n/;

/** 送り元を先頭の段落に書いた本文を作る */
export function formatPeerMessage(from: PeerMessageFrom, text: string): string {
  const title = from.title.replace(/\s+/g, ' ').trim() || '無題';
  return (
    `[AgentPWA] セッション「${title}」（${PEER_AGENT_LABEL[from.agent]}、ID: ${from.sessionId}）からのメッセージです。` +
    `返事が要るときは、このセッション ID 宛てに送ってください。\n\n${text}`
  );
}

/** formatPeerMessage で作った本文を、送り元と本文に分ける（そうでなければ null） */
export function parsePeerMessage(text: string): { from: PeerMessageFrom; text: string } | null {
  const m = PEER_HEAD.exec(text);
  if (!m) return null;
  const agent: AgentKind = m[2] === 'Codex' ? 'codex' : 'claude';
  return { from: { title: m[1], agent, sessionId: m[3] }, text: text.slice(m[0].length) };
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

/**
 * 送信に添える添付ファイル（v7）。data は base64。
 * 画像はそのまま画像としてエージェントに渡し、それ以外は Driver がファイルに保存してパスを伝える。
 */
export interface Attachment {
  name: string;
  /** 例: 'image/png'。分からなければ 'application/octet-stream' */
  mimeType: string;
  data: string;
}

/** 会話の記録に残す添付ファイルの情報（中身は持たない）。 */
export interface AttachmentInfo {
  name: string;
  mimeType: string;
  /** バイト数 */
  size: number;
}

/** スラッシュコマンド（v7）。名前は先頭の / を含まない。 */
export interface SlashCommand {
  name: string;
  description?: string;
  /** 引数の説明（例: '[low|medium|high]'） */
  argumentHint?: string;
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

/** 質問の選択肢（v8）。 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** 1つの問い（v8）。 */
export interface QuestionItem {
  question: string;
  /** 短い見出し（例: 'Port'） */
  header?: string;
  /** 選択肢。空なら自由記述だけ。Web は選択肢に加えて、常に自由記述（その他）も受け付ける。 */
  options: QuestionOption[];
  /** 複数選べる */
  multiSelect?: boolean;
}

/** Driver → Hub のイベント。Hub が sessionId / seq / at を付けて保存・配信する。 */
export type DriverEvent =
  | { type: 'status'; status: SessionStatus; reason?: string }
  /** アシスタント発話のストリーミング断片。最後に同じ messageId の `message` を送ること。 */
  | { type: 'message_delta'; messageId: string; text: string; parentToolId?: string }
  | {
      type: 'message';
      messageId: string;
      role: 'user' | 'assistant';
      text: string;
      /** ユーザーの発言に添えた添付ファイル（v7。中身は入れない） */
      attachments?: AttachmentInfo[];
      /** v10: サブエージェントの発話なら、それを起動したツールの toolId（`subagent` イベントの toolId） */
      parentToolId?: string;
      /**
       * v11: ユーザーの発言で、この発言まで巻き戻す（rewind）・ここからフォークする（forkToken）ことができる。
       * Driver が対応していて、この messageId をエージェント側の発言と結び付けられるときだけ true にする。
       */
      rewindable?: boolean;
    }
  | {
      type: 'tool';
      toolId: string;
      /** 例: 'Bash', 'Edit', 'Read'（エージェント固有名のままでよい） */
      name: string;
      /** 一行要約。例: 'npm test -- api' / 'src/api.ts +6 −4' */
      summary: string;
      /**
       * ツールが対象にしたファイルのパス（作業フォルダからの相対パスか絶対パス）。
       * Web のファイルビュワーで開くために使う。分かる場合だけ入れる。
       */
      paths?: string[];
      state: 'running' | 'done' | 'failed';
      output?: string;
      /** v10: サブエージェントが使ったツールなら、そのサブエージェントを起動したツールの toolId */
      parentToolId?: string;
    }
  /**
   * v10: サブエージェント（エージェントが作業を任せた子のエージェント）の状態。
   * 起動したとき・進んだとき・終わったときに、同じ toolId で送る（後のものが前のものを上書きする）。
   * ただし省いた agentType / prompt / result は前の値のままとする（長い prompt は最初の1回だけでよい）。
   * progress は省けば消える。
   * サブエージェント内の発話とツールは、`message` / `tool` の `parentToolId` にこの toolId を入れて送る。
   */
  | {
      type: 'subagent';
      /** サブエージェントを起動したツールの toolId（同じ toolId の `tool` イベントもある） */
      toolId: string;
      /** 種類。例: 'Explore', 'general-purpose'（エージェント固有名のままでよい） */
      agentType?: string;
      /** 一行の説明。例: '失敗テストの原因調査' */
      description: string;
      /** サブエージェントに渡した指示 */
      prompt?: string;
      state: 'running' | 'done' | 'failed' | 'stopped';
      /** 実行中の今の作業（一行） */
      progress?: string;
      /** 終わったときの報告 */
      result?: string;
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
  | {
      type: 'question';
      requestId: string;
      /** 質問文（複数の問いは改行でつなぐ）。一覧の表示や、`questions` を読まない UI に使う。 */
      prompt: string;
      /** 選択肢（問いが1つのときの古い形）。`questions` があれば UI はそちらを使う。 */
      options?: string[];
      /** v8: 問いごとの見出し・選択肢・複数選択。1回に複数の問いをまとめて聞くエージェントは、これを入れる。 */
      questions?: QuestionItem[];
    }
  | { type: 'question_resolved'; requestId: string }
  /** 再開に必要なエージェント固有 ID（Claude の session_id、Codex の thread.id など）。分かった時点ですぐ送る。 */
  | { type: 'resume_token'; token: string }
  /**
   * 現在の権限モード。起動直後と、モードが変わったとき（set_permission_mode の反映、
   * エージェント自身による変更（例: 計画モードの終了））に送る。
   * Hub と Web はこのイベントの値を「現在のモード」として扱う。
   */
  | { type: 'permission_mode'; mode: PermissionMode }
  /**
   * 現在のモデルとエフォート（どちらも省略はエージェントの既定）。起動直後と、set_model を反映したときに送る。
   * 差分ではなく、両方の現在値を送る。Hub と Web はこのイベントの値を「現在の設定」として扱う。
   */
  | {
      type: 'model';
      model?: string;
      effort?: EffortLevel;
      /**
       * 実際に使われるモデルとエフォート（既定やエイリアスを解決した値。例: 'claude-opus-5-5' と 'medium'）。
       * Driver が調べられたときだけ付ける。UI はこれで「既定」が何なのかを表示する。
       */
      resolvedModel?: string;
      resolvedEffort?: EffortLevel;
    }
  /**
   * v11: 会話を巻き戻した。messageId（ユーザーの発言）とそれより後の会話は、以後のエージェントの文脈に含まれない。
   * Hub と Web は、この発言から rewound までの記録を会話の表示から外す。
   */
  | { type: 'rewound'; messageId: string }
  | {
      type: 'usage';
      label: string;
      percent?: number;
      resetsAt?: string;
      /**
       * 枠の長さ（分）。5時間枠は 300、週間枠は 10080。
       * UI はこれでバーのメモリの数を決める（5時間枠は1時間ごとの5等分、週間枠は1日ごとの7等分）。
       */
      windowMinutes?: number;
    }
  /**
   * v12: コンテキスト（会話の文脈）の使用量。本流の直近の API 呼び出しの入力（キャッシュ分を含む）と出力のトークンの合計を
   * usedTokens に入れる。windowTokens はそのモデルのコンテキストの上限（分かったときだけ）。差分ではなく現在値を送る。
   * Hub と Web はこのイベントの値を「現在の使用量」として扱い、UI は usedTokens / windowTokens の割合を出す。
   */
  | { type: 'context'; usedTokens: number; windowTokens?: number }
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
  /** 添付ファイルがあれば text は空でもよい（添付は supportsAttachments の Driver だけ） */
  | { type: 'send'; text: string; attachments?: Attachment[] }
  | { type: 'approve'; requestId: string; decision: ApprovalDecision; note?: string }
  | {
      type: 'answer';
      requestId: string;
      /** 回答の全文（`answers` を読まない Driver はこれを使う）。 */
      text: string;
      /** v8: `questions[i]` への回答を i 番目に入れる（複数選択は「, 」でつなぐ）。`questions` の無い質問では省く。 */
      answers?: string[];
    }
  | { type: 'interrupt' }
  /** 実行中に権限モードを変える。反映できたら Driver が permission_mode イベントを送る。 */
  | { type: 'set_permission_mode'; mode: PermissionMode }
  /**
   * 実行中にモデルとエフォートを変える。省略した項目は変えず、null はエージェントの既定に戻す。
   * 反映できたら Driver が model イベントを送る。できなければ error（fatal: false）を送り、元の設定のままにする。
   */
  | { type: 'set_model'; model?: string | null; effort?: EffortLevel | null }
  /**
   * v11: ユーザーの発言（messageId。rewindable のもの）の直前まで巻き戻す。Hub はターンの途中（作業中・待ち）では送らない。
   * restore: 'conversation' は会話だけ、'code' はファイルだけ（その発言の直前の内容に戻す）、'both' は両方。
   * 会話を戻したら Driver が rewound を送る。失敗したら例外にする（Hub が Web にエラーを返す）。
   */
  | { type: 'rewind'; messageId: string; restore: RewindRestore };

/** 巻き戻しで戻すもの（v11） */
export type RewindRestore = 'conversation' | 'code' | 'both';

/** 各 Driver パッケージが実装するインターフェース。 */
export interface AgentDriver {
  readonly kind: AgentKind;
  /** CLI の有無と認証方式を確認する。起動前に Hub が必ず呼ぶ。 */
  checkAuth(): Promise<AuthCheck>;
  /** セッションを開始（または resumeToken で再開）する。emit は何度呼んでもよい。 */
  start(opts: StartOptions, emit: (event: DriverEvent) => void): Promise<DriverSession>;
  /**
   * 任意。Hub でセッションを削除したときに、エージェント側に残る履歴も消す。
   * Hub はセッションを止めてから呼ぶ。実装しない Driver では、エージェント側の履歴は残る。
   * アーカイブは Hub だけで扱うので、Driver には何も届かない。
   */
  deleteHistory?(target: { cwd: string; resumeToken: string }): Promise<void>;
  /**
   * 任意（v7）。作業フォルダで使えるスラッシュコマンドの一覧。Web の入力欄の補完に使う。
   * 実装しない Driver では補完を出さない（入力した /… はそのまま send で届く）。
   */
  listCommands?(cwd: string): Promise<SlashCommand[]>;
  /** 任意（v7）。添付ファイルを受け付けるか。省略か false なら、Hub は添付つきの send を拒否する */
  readonly supportsAttachments?: boolean;
  /** 任意（v11）。UserAction の rewind を受け付けるか。省略か false なら、Hub は rewind を拒否する */
  readonly supportsRewind?: boolean;
  /**
   * 任意（v11）。セッションをフォークする。messageId（rewindable なユーザーの発言）のターンの終わりまでの会話を引き継ぐ
   * 新しいセッションの resumeToken を返す（Hub はこれを StartOptions.resumeToken に渡して新しいセッションを始める）。
   * エージェント側の新しい ID は、起動後に resume_token で送り直してよい。元のセッションは変えない。
   * 実装しない Driver では、Web はフォークを出さない。
   */
  forkToken?(target: { cwd: string; resumeToken: string; messageId: string }): Promise<string>;
}

export interface DriverSession {
  send(action: UserAction): Promise<void>;
  /** プロセスを終了する。終了後に status: 'stopped' を emit すること。 */
  stop(): Promise<void>;
}
