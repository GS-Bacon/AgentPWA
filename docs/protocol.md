# プロトコル仕様（Hub ⇔ Driver ⇔ Web）

型定義の正本は [packages/shared/src/protocol.ts](../packages/shared/src/protocol.ts) です。この文書は、型だけでは伝わらない「振る舞いの約束」を書きます。

## 1. 役割

| 層 | 担当 | やること |
|---|---|---|
| Driver | Claude 用は Claude、Codex 用は Codex | CLI を起動し、エージェント固有の出力を `DriverEvent` に正規化する。`UserAction` を CLI への入力に変換する |
| Hub | Claude | セッション管理、イベント保存（SQLite）、既読管理、優先度の並べ替え、Web Push、認証 |
| Web | Claude（Codex 固有の表示部品だけは Codex） | 一覧・ペイン表示・許可操作 |

Hub と Web は `AgentKind` で表示を分けるだけで、エージェントの内部仕様には依存しません。

## 2. 状態遷移

```
starting ──► running ──► idle ──(send)──► running
               │  ▲
               │  └──(approve / answer)──┐
               ├──► waiting_approval ────┘
               └──► waiting_input ───────┘
どの状態からも ──► error / stopped
```

- 許可要求: `approval_request` を送り、**その直後に** `status: waiting_approval` を送る。
- 許可の決定を受けたら `approval_resolved` を送り、続けて `status: running` を送る。
- 質問（`question`）も同じ流れで、`waiting_input` → `question_resolved` → `running` の順にする。
- ターンが終わったら `status: idle` を送る。「完了・未読」は Hub が既読管理から付ける。
- 許可待ちが複数同時に出るエージェントでは、`approval_request` を複数送ってよい。すべて解決するまで `waiting_approval` のままにする。

## 3. Driver が守ること

1. **サブスクリプション前提**: `checkAuth()` で API キー（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` など）が効く状態を検出したら、`auth: 'api_key'` を返す。Hub はそのセッションを起動しない。
2. **再開**: エージェント固有の ID が分かった時点で、すぐに `resume_token` を送る。Hub が落ちても、この値があれば `StartOptions.resumeToken` で再開できる。
3. **プロセス管理**: `stop()` では子プロセスを確実に終了させ、最後に `status: stopped` を送る。CLI が勝手に落ちたら `error`（復帰できるなら `fatal: false`）を送る。
4. **ID**: `messageId` / `toolId` / `requestId` は、セッション内で一意な文字列にする。エージェントの ID をそのまま使ってよい。
5. **権限モード**: `PermissionMode` を、エージェント固有の設定に対応付ける。対応する設定がないモードは `ask` として扱い、`error`（`fatal: false`）で理由を知らせる。詳しくは「3.1 権限モードの切り替え」を参照。
6. **ツールの対象ファイル**: ファイルを読む・書く・変えるツールの `tool` イベントには、対象ファイルのパスを `paths` に入れる（作業フォルダからの相対パスか絶対パス）。Web はこれを使ってファイルビュワーで開く。分からないときは省いてよい。同じ `toolId` の続きのイベントでは省いてもよい（Hub と Web は最初の値を使い続ける）。

### 3.1 権限モードの切り替え

- 起動したら、実際に使っているモードを `permission_mode` で送る（対応がなく `ask` に落とした場合は `ask` を送る）。
- `set_permission_mode` を受けたら、エージェントに反映してから `permission_mode` を送る。反映できなければ `error`（`fatal: false`）を送り、`permission_mode` は送らない（元のモードのまま）。
- どの状態（`running` / `idle` / `waiting_*`）でも受け付ける。実行中のターンにすぐ効かないエージェントは、次のターンから反映し、そのことを `permission_mode` の送信時点で反映済みとみなしてよい（対応表に書く）。
- エージェント自身がモードを変えたとき（例: Claude の計画モードの終了）も `permission_mode` を送る。
- 切り替えても、すでに出ている `approval_request` は自動で解決しない。ユーザーが個別に決める。
- `full_auto` は、Hub が「フォルダの許可リストで `full_auto` を許可したフォルダ」のセッションにだけ渡す。それ以外のセッションへの `set_permission_mode`（`full_auto`）は Hub が拒否し、Driver には届かない。
- `auto`（自動承認）はフォルダの制限なしで使える。危険と判定された操作はエージェント側で止まるため、`full_auto` とは扱いを分ける。

### 3.2 モデルとエフォートの切り替え

- `StartOptions.model` / `effort` は、どちらも省略でエージェントの既定。`model` はエイリアス（例: `opus`）か正式名で、Hub が使える文字（英数字と `. _ - : [ ]`、100 文字まで）を確かめてから渡す。
- 起動したら、使っている設定を `model` イベントで送る（`model` / `effort` とも、既定なら省く）。
- 既定やエイリアスが実際に何になるか（例: 既定 → `claude-opus-5-5`、エフォートの既定 → `medium`）を調べられるエージェントは、`model` イベントの `resolvedModel` / `resolvedEffort` に入れる（任意）。分かった時点でもう一度 `model` を送ってよい。UI は「既定（Opus 5.5）」のように表示する。
- `set_model` を受けたら、指定された項目だけを変える（省略は変えない、`null` は既定に戻す）。エージェントに反映してから、両方の現在値を `model` で送る。反映できなかった項目があれば `error`（`fatal: false`）を送り、その項目は元の値のまま `model` を送る。
- どの状態（`running` / `idle` / `waiting_*`）でも受け付ける。実行中のターンにすぐ効かないエージェントは、次のターンから反映し、そのことを `model` の送信時点で反映済みとみなしてよい（対応表に書く）。
- エージェントに無いエフォート（例: `max`）は、`error`（`fatal: false`）で知らせて元の値のままにする。
- 動いていないセッションへの `set_model` は Hub が覚えておき（`model` イベントを Hub が記録する）、次に起動・再開するときに `StartOptions` で渡す。

### 3.3 添付ファイルとスラッシュコマンド（v7）

- **添付ファイル**: `send` の `attachments`（名前・MIME タイプ・base64 の中身）で届く。添付があれば `text` は空でもよい。受け付ける Driver は `AgentDriver.supportsAttachments` を `true` にする。そうでない Driver のセッションへの添付つきの `send` は、Hub が 400 で断る（Driver には届かない）。
  - Hub が確かめる上限: 1回の送信で 10 件、合計 20MB（Web は大きな画像を長い辺 2000px までに縮めてから送る）。
  - Driver は、ユーザーの発言の `message` イベントに `attachments`（名前・MIME タイプ・バイト数。中身は入れない）を付けて送る。Web は発言の下にファイル名を出す。
  - 変換できない添付（エージェントが受け付けない種類など）は、`send` を例外で失敗させる（Hub が呼び出し元にエラーを返す）。
- **スラッシュコマンド**: 入力欄の補完のため、Driver は任意で `listCommands(cwd)` を実装する。Hub は `GET /api/sessions/:id/commands` で返し、AI と作業フォルダごとに 5 分覚えておく。実装しない Driver では補完を出さない。
  - コマンドの実行そのものは `send` の本文（`/compact` など）で届く。どう扱うかは Driver に任せる。
- Web が添付ボタンや補完を出すかは、`GET /api/info` の `agents.<AI>.attachments` / `commands`（Hub が Driver から求める）で決める。

### 3.4 質問（v8）

- 1回に複数の問いをまとめて聞くエージェントは、`question` の `questions`（問いごとの `question` / `header` / `options`（`label` / `description`）/ `multiSelect`）を入れる。`prompt` には問いの文を改行でつないで入れる（一覧の表示用）。問いが1つなら、古い Web のために `options` にもラベルを入れておく。
- Web は `questions` があれば問いごとに選択肢と自由記述（その他）を出し、全問に答えてから `answer` を送る。`answer` の `answers[i]` が `questions[i]` への回答（複数選択は「, 」でつなぐ。自由記述は選択肢と同じ並びに足す）。`text` には全問をまとめた文を入れるので、`answers` を読まない Driver はそれを使えばよい。
- `questions` の無い質問には、Web は `answers` を付けない（従来どおり `text` だけ）。

### 3.5 セッションのアーカイブと削除

- アーカイブと削除は Hub が扱う。Driver に `UserAction` は届かない。
- Hub は、動いているセッション（`stopped` 以外）をアーカイブ・削除する前に `stop()` を呼ぶ。アーカイブを戻したセッションは `stopped` のままで、次に送信したときに `resumeToken` で再開する。
- 削除では、Hub が自分の記録（セッションとイベント）を消したあと、Driver が `deleteHistory` を実装していれば、`resume_token` で受け取った値を渡して呼ぶ。失敗しても Hub 側の削除は取り消さず、Web に失敗を知らせる。
- `deleteHistory` は、そのセッションの履歴だけを消す。同じフォルダの他のセッションや、エージェントの設定には触れない。

### 3.6 サブエージェント（v10）

エージェントが作業の一部を子のエージェント（サブエージェント）に任せる仕組みがあれば、Web はその中身をペインの下側のサブペインに出す（docs/architecture.md の 5章）。

- サブエージェントを起動したツールの `toolId` を、そのサブエージェントの ID にする。起動したとき・進んだとき・終わったときに、`subagent` イベント（`toolId` / `agentType` / `description` / `prompt` / `state` / `progress` / `result`）を送る。
  - 同じ `toolId` の後のイベントが前のものを上書きする。ただし省いた `agentType` / `prompt` / `result` は前の値のまま（長い `prompt` は最初の1回だけでよい）。`progress` は省けば消える。`description` は空文字なら前の値のまま。
  - `state` は `running` → `done` / `failed` / `stopped` の一方向。終わった後に `running` へ戻さない。エージェントのプロセスが終わって行方が分からなくなったものは `stopped` にする。
  - 起動したツール自身の `tool` イベントも、今までどおり送る（Web はこのツールを本流の「◆」の行に置き換える）。ツールが終わってもサブエージェントは動き続けることがある（裏で動くもの）ので、終わりは `subagent` の `state` で知らせる。
- サブエージェントの中の発言とツールは、`message` / `message_delta` / `tool` に `parentToolId`（そのサブエージェントの `toolId`）を付けて送る。Web と Hub は、`parentToolId` の付いたイベントを本流の会話に出さない。サブエージェントの中から起動したサブエージェントも、同じ形で入れ子にできる。
- サブエージェントが出した許可要求・質問は、今までどおり `approval_request` / `question` で送る（`parentToolId` は付けない）。`requestId` がサブエージェントの中の `tool` の `toolId` と同じなら、Web はどのサブエージェントからのものかを示す。
- Hub はこのイベントを保存・配信するだけで、セッションの状態（`status`）には使わない。本流が `idle` でも、裏でサブエージェントが動いていることがある。

### 3.7 巻き戻しとフォーク（v11）

Web では、送ったメッセージの下に「フォーク・巻き戻し・編集・コピー」を出す（Claude のデスクトップアプリと同じ並び）。

- 対象にできるのは、Driver が `message`（`role: 'user'`）に `rewindable: true` を付けた発言だけ。Driver は、その `messageId` からエージェント側の発言を特定できるときだけ付ける。
- **巻き戻し**: `UserAction` の `rewind`（`messageId`、`restore`: `conversation` / `code` / `both`）。発言の直前の状態に戻す。`code` はファイルの内容を、その発言を送る前の状態に戻す。
  - Hub はターンの途中（`starting` / `running` / `waiting_*`）では受け付けない。止まっているセッションでは Driver を起動してから渡す。
  - 会話を戻したら、Driver は（必要なら新しい `resume_token` を送ってから）`rewound` を送る。Hub と Web は、その発言から `rewound` までの記録を会話の表示とフォークの写しから外す（記録そのものは消さない）。
  - 失敗したら例外にする（何も変えない）。ファイルと会話の両方を戻すときは、ファイルを戻せなければ会話も戻さない。
  - 編集は Web が「`rewind`（`conversation`）→ 直した文の `send`」で行う。巻き戻しで会話を戻したときは、Web が戻した発言を入力欄に入れる。
- **フォーク**: Hub の `POST /api/sessions/:id/fork`（`{ messageId }`）。Hub は `AgentDriver.forkToken` で新しいセッションの `resumeToken` をもらい、その発言のターンの終わり（次のユーザーの発言の直前）までの表示用のイベント（`message` / `tool` / 許可・質問とその解決）を写した新しいセッションを作る。起動は最初の送信まで待つ。元のセッションは変えない。まだ終わっていない最後のターンからはフォークできない。
- `supportsRewind` / `forkToken` が無い Driver では、Web は巻き戻し・編集・フォークを出さない（コピーだけ）。

### 3.8 Hub の説明とセッション間のメッセージ（v13）

- Hub は起動・再開のたびに `StartOptions.hubGuide`（Markdown）を渡す。Hub の API の使い方（新しいセッションの作成、ほかのセッションへのメッセージ、入力欄の # の候補）と、このセッションの ID を含む。Driver はこれを、エージェントのシステムプロンプト（開発者向けの指示）にそのまま足す。省略されたら何も足さない。
- ほかのセッションから届いたメッセージは、Hub が本文の先頭に送り元の段落（`formatPeerMessage`）を付けた、ふつうの `send` として届く。Driver は特別な扱いをしない（ユーザーの発言と同じく送り、`message`（`role: 'user'`）にもそのままの本文を入れる）。Web が `parsePeerMessage` で送り元を取り出して表示する。

## 4. 単体での開発とフィクスチャ

Hub ができる前でも、各 Driver を単独で開発・確認できるようにします。

- `packages/driver-*/scripts/try.ts`: Driver を直接起動し、標準入力から `UserAction` を JSON で受け取り、`DriverEvent` を1行1件の JSON（JSONL）で出力する簡易ツール。
- `packages/driver-*/fixtures/*.jsonl`: 実際のセッションで記録した `DriverEvent` 列。Web の表示確認とテストに使う。最低でも「許可要求が来て許可する」「質問に答える」「中断する」の3本を用意する。

## 5. エージェント固有の対応表

各 Driver の担当者が埋めてください。

### Claude（`claude` CLI ヘッドレス）— Claude 担当

確認した版: Claude Code 2.1.327（Windows）。

| プロトコル | Claude Code 側 |
|---|---|
| 起動 | `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-mode <mode> --permission-prompt-tool stdio --allow-dangerously-skip-permissions`。子プロセスは起動役（`local` / `ssh`）を通して起動する（6.6 の v4 までは Driver 内に起動役を持つ）。プロセスは最初の送信で起動し、ターンが終わっても標準入力を開いたまま次の指示を待つ。返答待ち（idle）のまま 20 分使われなければプロセスを終わらせ（バックグラウンド作業が動いている間は待つ）、次の送信で `--resume` して起動し直す。状態は idle のまま |
| 送信 | 標準入力に `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}` を1行で書く。実行中に送ったものは CLI 側で次のターンに回る |
| 添付ファイル | PNG / JPEG / GIF / WebP（3.75MB まで）は `content` を配列にして `{"type":"image","source":{"type":"base64","media_type":…,"data":…}}` で渡す。それ以外は Hub のPCの一時フォルダ（`<tmp>/agentpwa-attachments/<sessionId>/`）に保存し、本文の後ろにパスを書き足して Read ツールで読ませる。このフォルダは起動時に `--add-dir` で渡すので、確認なしで読める。SSH 先のマシン（起動役を差し替えたとき）では画像だけ受け付ける |
| スラッシュコマンド | 一覧は、CLI を短く起動して制御要求 `{"subtype":"initialize"}` を送り、応答の `commands`（`name` / `description` / `argumentHint`）を使う（API は呼ばない）。`__` で始まる内部用は除く。実行は本文をそのまま送る（`/context` などの出力は、モデル `<synthetic>` の assistant メッセージで届く）。ただし引数つきの `/model <名前>` と `/effort <段階>` は CLI に送らず、`set_model` と同じ処理にする（Hub と Web の表示をそろえるため。`default` / `auto` は既定に戻す） |
| 許可要求 | `--permission-prompt-tool stdio` で、CLI から標準出力に `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name","input","tool_use_id",…}}` が届く。これを `approval_request`（`requestId` = tool_use_id）に変換する。決定は標準入力に `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":…}}}`（拒否は `{"behavior":"deny","message":…}`）で返す。CLI が `control_cancel_request` で取り下げたら、`approval_resolved`（deny）にする。MCP ツールは使わない（SSH 先の CLI から届かないため。docs/architecture.md の 6.4） |
| allow_session | CLI には渡さず Driver が覚える。シェル（Bash / PowerShell）はコマンドの先頭の語ごと、それ以外はツール名ごとに、以後の問い合わせを自動で許可する |
| 質問 | `AskUserQuestion` の許可要求を `question` に変換する。`input.questions` を問いごとに `questions` に入れる（`options` は問いが1つのときだけ）。回答は `updatedInput.answers = {質問文: 回答}` で、`answer.answers[i]` を i 番目の問いの答えにする（`answers` が無ければ `text` を全問の答えにする） |
| プランの承認 | `ExitPlanMode` の許可要求を `approval_request`（`kind: 'other'`、`command` にプラン本文、choices は allow / deny）にする |
| 再開 | `--resume <session_id>`（`resume_token` = system/init の session_id）。Hub 再起動後や CLI が落ちた後は、次の送信で起動し直す |
| 中断 | 標準入力に `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` を書く。5 秒以内に result が来なければプロセスを終了し、次の送信で `--resume` する。どちらも `status: idle`（reason: 中断しました）にする |
| 権限モード（起動時） | `--permission-mode`: `ask`→`default`、`auto_edit`→`acceptEdits`、`auto`→`auto`、`full_auto`→`bypassPermissions`、`plan`→`plan`。`full_auto` へ後から切り替えられるよう、常に `--allow-dangerously-skip-permissions` を付ける |
| 権限モード（実行中） | プロセスが動いていれば、標準入力へ `{"type":"control_request","request_id":…,"request":{"subtype":"set_permission_mode","mode":…}}` を送る。`control_response` の success で反映とみなす（実行中のターンにもすぐ効く）。error なら `error`（`fatal: false`）を送り、元のモードのままにする。プロセスが止まっていれば、次の起動の `--permission-mode` に使う |
| 自動承認（`auto`） | Claude Code の auto モード（安全判定の分類器が操作ごとに許可を決める）を使う。プランやモデルの条件で使えないときは、CLI が返すエラーを `error`（`fatal: false`）で知らせて元のモードのままにする。分類器が止めた操作が `can_use_tool` で届いたときは、通常どおり `approval_request` にする |
| モデル・エフォート（起動時） | `--model <model>` と `--effort <level>`（`low` / `medium` / `high` / `xhigh` / `max`。プロトコルの値そのまま）。省略は付けない。起動したら（プロセスを起動する前に）`model` を送る |
| モデル・エフォート（実行中） | プロセスが動いていれば、モデルは `{"type":"control_request","request_id":…,"request":{"subtype":"set_model","model":…}}`（既定に戻すときは `model` を省く）、エフォートは `{"subtype":"apply_flag_settings","settings":{"effortLevel":…}}`（既定に戻すときは `null`）を送る。`control_response` の success で反映とみなす（実行中のターンも次の API 呼び出しから効く）。知らないモデルは error（`Model '…' not found`）が返るので、`error`（`fatal: false`）を送り元のモデルのままにする。プロセスが止まっていれば、次の起動の `--model` / `--effort` に使う。`model` イベントの `model` / `effort` は Driver が頼んだ値（エイリアスのまま） |
| 既定の解決（`resolvedModel` / `resolvedEffort`） | 制御要求 `{"subtype":"get_settings"}` の応答の `applied.model` / `applied.effort` を使う（設定ファイルの `modelSettings` なども反映済みの値。Opus 5 は既定が `high` など、モデルごとに違う）。プロセスが動いていればそこへ送り、動いていなければ同じ `--model` / `--effort` で短く起動して聞き、すぐ終了する（API は呼ばないので使用量は減らない）。起動直後と `set_model` のたびに調べ、分かったら `model` を送り直す |
| ツールの対象ファイル（`paths`） | `Read` / `Write` / `Edit` / `MultiEdit` の `file_path`、`NotebookEdit` の `notebook_path`（CLI が渡す絶対パスのまま） |
| モードの通知 | stream-json の `system/init` と `system/status` の `permissionMode` を、上の対応の逆で `permission_mode` にして送る（計画モードの終了など、CLI 自身による変更もここで届く） |
| 巻き戻し・フォークの対象（`rewindable`） | 送るときに `{"type":"user","uuid":<新しい UUID>,…}` と uuid を付ける。CLI は会話の記録（`~/.claude/projects/<…>/<session_id>.jsonl`）でもこの uuid を使うので、`messageId` にこの uuid を入れて `rewindable: true` にする。起動役が記録を読めない（`readText` が無い）ときは付けない |
| 巻き戻し（会話） | 記録の jsonl から発言の `parentUuid` を求め、次の起動を `--resume <id> --resume-session-at <parentUuid> --fork-session`（どちらもヘルプに出ないが 2.1.327 にある）にする。新しい session_id は起動しないと分からないので、`resume_token` に `<id>|at=<uuid>|fork` の形で「途中から始める予定」を入れて送り、起動後の system/init で新しい session_id を送り直す。発言が会話の最初なら `fresh`（何も引き継がずに始める）。プロセスは終わらせてから行う |
| 巻き戻し（コード） | 環境変数 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` で起動して、CLI にファイルの変更前の控えを取らせておく（ヘッドレスでは既定で取らない）。巻き戻すときは `claude -p --resume <id> --rewind-files <発言の uuid>` を実行する。戻るのは Write / Edit などのファイル編集ツールで変えた分だけ（Bash で変えたファイルは戻らない）。この設定より前のセッションには控えが無いので失敗する |
| フォーク（`forkToken`） | 記録の jsonl で、発言の後の最初のユーザーの発言の `parentUuid` を求め、`<id>|at=<それ>|fork` を返す（最後のターンなら `<id>|fork`）。フォークした記録にはファイルの控えも写るので、フォーク先でもコードを巻き戻せる |
| 履歴の削除（`deleteHistory`） | `~/.claude/projects/<cwd の英数字以外を - に置き換えた名前>/<session_id>.jsonl` と、同名のフォルダ（あれば）を消す。`claude --resume` の一覧からも消える |
| 認証の確認 | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` があれば `api_key`。無ければ `claude auth status`（JSON）の `authMethod` を見て、`claude.ai` / `oauth_token` は `subscription`、`api_key` / `api_key_helper` / `third_party` は `api_key`。起動後も system/init の `apiKeySource` が `none` 以外なら、エラー（fatal）を出して止める |
| 使用量 | `rate_limit_event` の `unifiedWindows.five_hour` / `seven_day` / `seven_day_overage_included` の utilization を `usage`（「セッション枠（5時間）」「週間」「Fable（週間）」）にする。`seven_day_overage_included` は CLI が「Fable limit」と呼ぶ週間枠で、その枠がある契約のときだけ届く。`windowMinutes` はそれぞれ 300 / 10080 / 10080 |
| コンテキストの使用量（v12） | `parent_tool_use_id` の無い assistant メッセージの `message.usage` の `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` + `output_tokens` を `context` の `usedTokens` にする（モデル `<synthetic>` は除く）。上限は result の `modelUsage[<モデル>].contextWindow`（Opus 5.5 は 1000000）を覚えて `windowTokens` に入れる。値が変わったときだけ送る。プロセスを起動し直した直後は上限が最初の result まで分からないので、Hub は前の上限を使い続ける |
| Hub の説明（v13） | `StartOptions.hubGuide` を `--append-system-prompt` で渡す。子プロセスの環境変数に `AGENTPWA_SESSION_ID`（Hub のセッション ID）も入れる |
| サブエージェント | `Agent`（古い版は `Task`）ツールの `tool_use` で `subagent`（running。`subagent_type` / `description` / `prompt`）を送る。`system/task_started` / `task_progress`（`description` を `progress` に）/ `task_updated`（`patch.status`）/ `task_notification`（`status` と `summary` を `result` に）を、`tool_use_id`（無いものは `task_id` から引く）で対応付けて送る。`task_type` が `local_agent` 以外（裏で動くシェルなど）は扱わない。既定では裏で動くので、`Agent` の `tool_result`（`tool_use_result.isAsync`）では終わりにしない。前面で動いたものは `tool_result` で `done` / `failed` にする。`parent_tool_use_id` の付いた assistant / user メッセージを、`parentToolId` 付きの `message` / `tool` にする（途中経過の stream_event は CLI が送らないので、`message_delta` は出さない）。CLI のプロセスが終わったら、動いたままのものを `stopped` にする |

### Codex への依頼の状況（2026-11-27 時点、main の driver-codex で確認）

| 依頼 | 状況 |
|---|---|
| 権限モード | 済み（Codex の対応表） |
| モデルとエフォート（v4・v6） | 済み。Web の選択肢（`MODELS.codex` / `EFFORTS.codex`）を `model/list` に合わせる作業が残っている |
| ツールの対象ファイル（v5） | 済み |
| 運用ルールの変更 | 未対応（AGENTS.md にまだ `protocol/*` ブランチと `codex/*` の決まりが残っている） |
| 添付ファイル（v7） | main では未対応（Codex が対応中）。スラッシュコマンドは未対応 |
| 質問の選択肢（v8） | 済み |
| 巻き戻しとフォーク（v11） | 未対応（任意） |
| セッションの削除 | 実装しないと決定（対応表の「履歴削除」） |
| 使用量の枠の長さ（v9） | 済み |
| サブエージェント（v10） | 未対応（任意） |
| コンテキストの使用量（v12） | 未対応（任意） |
| Hub の説明（v13） | 済み |

### Codex への依頼（権限モード）

Codex 担当で、次を対応表に追加してください（AGENTS.md と driver-codex は Codex 担当）。
- `ask` / `auto_edit` / `auto` / `full_auto` / `plan` と、承認ポリシー・サンドボックス設定（例: `full_auto` は承認なし）の対応
- `auto`（自動承認）は、承認をエージェント側の判定（AI による自動レビューなど）に任せる設定があれば対応付ける。なければ 3章5の決まりどおり `ask` に落とす
- 実行中の切り替え方法（`turn/start` ごとに指定するなら「次のターンから反映」と明記）
- `plan` に当たる設定がなければ、3章5の決まりどおり `ask` に落とす

### Codex への依頼（モデルとエフォート）

Codex 担当で、次を対応してください（プロトコル v4。3.2 を参照）。
- `StartOptions.model` / `effort` を `thread/start`（または `turn/start`）のモデル・推論の深さ（reasoning effort）に対応付け、起動後に `model` イベントを送る
- `set_model` を受けたら反映し、`model` イベントを送る。`turn/start` ごとに指定するなら「次のターンから反映」と対応表に書く
- Codex に無いエフォート（例: `max`）は `error`（`fatal: false`）で知らせる。Web の選択肢は `packages/web/src/lib/models.ts` の `EFFORTS.codex`（いまは `low` / `medium` / `high` / `xhigh`）と `MODELS.codex`（いまは既定だけ）なので、選べるモデルとエフォートが決まったら知らせてください（Claude 側で直します）
- （任意、v6）既定のモデルとエフォートが実際に何になるかを app-server から取れるなら、`model` イベントの `resolvedModel` / `resolvedEffort` に入れてください。Web が「既定（…）」と表示します

### Codex への依頼（ツールの対象ファイル）

Codex 担当で、次を対応してください（プロトコル v5。3章6を参照）。
- ファイル変更など、ファイルを対象にする項目の `tool` イベントに `paths` を入れ、対応表に書く

### Codex への依頼（運用ルールの変更）

`packages/shared` の変更に専用のブランチと PR を作る決まりと、ブランチ名の決まり（`claude/*` / `codex/*` / `protocol/*`）をなくしました（CLAUDE.md と docs/architecture.md は変更済み）。`packages/shared` は直接変えてよく、変えたらこの文書の変更履歴に追記し、相手側の対応が要るものは依頼の節に書きます。AGENTS.md の該当箇所（`packages/shared/**` の項と、ブランチ名の項）を同じ内容に直してください。

### Codex への依頼（添付ファイルとスラッシュコマンド、v7）

Codex 担当で、できるものから対応してください（3.3 を参照。どちらも任意で、対応するまで Web は添付ボタンと補完を出しません）。
- 添付ファイル: app-server が画像（やファイル）の入力を受け付けるなら、`send` の `attachments` を渡し、`supportsAttachments: true` にする。ユーザーの発言の `message` イベントに `attachments`（中身なし）を付ける
- スラッシュコマンド: 使えるコマンドの一覧が app-server から取れるなら `listCommands(cwd)` を実装する。ユーザーから「Codex のセッションでも `/` の補完を出したい」と要望がありました（2026-11-25）。スキルやカスタムプロンプトの一覧（例: app-server の skills の一覧のメソッド、`~/.codex/prompts`）を `SlashCommand` にして返してください。実装すれば Web 側はそのまま補完を出します（`@` のファイルと `#` のプロジェクトの候補は Hub と Web だけで動くので、Codex 側の対応は要りません）
- 権限モードの既定が `DEFAULT_PERMISSION_MODE`（`auto`）になりました。`auto` に当たる設定が無ければ、3章5のとおり `ask` に落としてください

### Codex への依頼（質問の選択肢、v8）

- Codex 側に、1回に複数の問いや選択肢つきの問いを出す仕組みがあれば、`question` の `questions` に入れ、`answer` の `answers`（問いごとの回答）で返してください（3.4 を参照）。無ければ対応は不要です（`prompt` / `options` と `text` は今までどおり使えます）。

### Codex への依頼（巻き戻しとフォーク、v11）

- 任意です。app-server にスレッドを途中まで巻き戻す・分岐させる仕組み（例: ターン単位のロールバックやフォーク）があれば、`rewindable` / `rewind` / `rewound` / `supportsRewind` / `forkToken` を実装して対応表に書いてください（3.7 を参照）。無ければ対応は不要です（Web はコピーだけ出します）。

### Codex への依頼（セッションの削除）

- `deleteHistory` を実装するか決めて、対応表に書いてください。app-server にスレッドを消す（またはアーカイブする）メソッドがあれば使い、なければ実装しなくてよい（Hub の記録だけ消える）。

### Codex への依頼（使用量の枠の長さ）

- （任意、v9）`usage` イベントに `windowMinutes`（枠の長さ（分）。5時間枠は 300、週間枠は 10080）を入れてください。app-server のレート制限に枠の長さ（`windowDurationMins` など）があればそのまま使えます。入っていれば、Web のバーに1時間ごと・1日ごとのメモリが付きます。

### Codex への依頼（サブエージェント、v10）

- Codex 側に、作業を子のエージェントに任せる仕組みがあれば、3.6 のとおり `subagent` イベントと `parentToolId` を送り、対応表に書いてください。無ければ対応は不要です（今までどおり本流だけが出ます）。

### Codex への依頼（コンテキストの使用量、v12）

- （任意）`context` イベント（`usedTokens`: 直近の呼び出しで文脈に入っているトークン数、`windowTokens`: モデルのコンテキストの上限）を送ってください。app-server のトークン使用量の通知（`thread/tokenUsage/updated` の `last` と `modelContextWindow` など）がそのまま使えるはずです。送れば、ペインのモデルとエフォートのボタンの横に使用率が出ます。

### Codex への依頼（Hub の説明、v13）

- `StartOptions.hubGuide` があれば、Codex の開発者向けの指示（`thread/start` / `thread/resume` の `developerInstructions` など、スレッドに付く指示）に足してください（3.8）。再開のたびに渡るので、同じ文が重ならないようにしてください。これで Codex のセッションも、新しいセッションの作成と、ほかのセッションへのメッセージができるようになります（説明は PowerShell の `Invoke-RestMethod` の例。ID は文中に書いてあるので、環境変数は要りません）。
- ほかのセッションからのメッセージは、ふつうの `send` として届きます。特別な対応は要りません。

### Codex（`codex app-server`）— Codex 担当

| プロトコル | Codex app-server 側 |
|---|---|
| 確認した版 | codex-cli **0.171.0-alpha.13**（Windows、Node.js 24.22.1、2026-11-24）。公式仕様と CLI 生成型を照合。認証・承認・質問・中断を実機確認。詳細と制約は [Driver README](../packages/driver-codex/README.md) |
| 初期化・起動 | `codex app-server --listen stdio://` → `initialize`（`experimentalApi: true`）→ `initialized` → `thread/start`。指示があるとき `turn/start`。JSONL の wire では `jsonrpc` ヘッダーを省略 |
| 認証・課金経路の拒否 | 環境の API キー・独自接続先を拒否。有効な `config/read`（cwd の設定も含む）と `account/read` で標準プロバイダー＋ChatGPT 認証だけを許可。開始後も再検査し、認証変更時は停止。送信・許可・回答の前に `account/rateLimits/read` の `ordinaryUsageAllowed: true`、残り枠あり、`credits.hasCredits: false` を必須とする。不明・枠切れ・追加クレジットありは拒否。`serviceTier: default` を明示 |
| 再開 | `thread/resume`。`thread.id` が分かればすぐ `resume_token`。過去の返答を再配信しない |
| Hub の説明（v13） | `hubGuide` があれば、有効な設定の開発者向け指示に足して `thread/start` / `thread/resume` の `developerInstructions` に渡す。再開時も組み直して置き換えるため重複しない。省略時は上書きしない。`collaborationMode.settings.developer_instructions: null` はモード標準の指示を選び、スレッドの指示を維持する。セッション間のメッセージは通常の `send` として扱う |
| 次の指示・実行中の追加指示 | アイドルでは `turn/start`、実行中は `turn/steer`（`expectedTurnId` つき）。操作を直列化し、開始応答後は `turn/started` を待って中断との競合を防ぐ |
| 中断・終了 | `turn/interrupt` → `turn/completed` の `interrupted` で `idle`。`stop()` は stdio を閉じ、残れば自分の子プロセスのツリーを終了し、最後に `stopped` |
| 許可要求 | `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` / `item/permissions/requestApproval` を `approval_request` に変換。直後に待機状態。同時要求はすべて解決するまで待機。RPC の文字列 ID と数値 ID を区別 |
| 許可の回答 | `allow` → `accept`、`allow_session` → `acceptForSession`、`deny` → `decline` または `cancel`。サーバーが指定した `availableDecisions` に絞る。追加権限は要求された権限だけを turn / session の範囲で返す。補足文 `note` は未対応のため理由を通知 |
| ファイル変更・対象パス | `item/started` の `fileChange.changes` を承認に添付。新規・削除ファイルの本文を unified diff に変換し、行数を集計。`tool.paths` は変更元・移動先、画像表示、`commandActions` の `read.path` を使用 |
| 質問 | `item/tool/requestUserInput`（旧名 `tool/requestUserInput` も受信）→ `question.questions`。見出し・選択肢・説明を保持し、`answer.answers[i]` を元の質問 ID ごとの `answers` に変換。秘密情報の質問と未知の要求は拒否 |
| 返答・ツール | `item/agentMessage/delta` → 同じ ID の確定 `message`。`item/started` / `item/completed` を `tool` に変換。中断・停止時の残りの返答断片も確定 |
| 権限モード（起動時） | `ask` = `untrusted` + `read-only`、`auto_edit` = `on-request` + `workspace-write`、`auto` = 同左 + `approvalsReviewer: auto_review`、`full_auto` = `never` + `danger-full-access`、`plan` = `never` + `read-only` + `collaborationMode: plan`。`ask` でも信頼された読み取りコマンドは Codex の判断で実行される。起動時に `auto` が反映できなければ理由を通知して `ask` に落とす |
| 権限モード（切り替え） | 次の `turn/start` から反映。現在のターンと未解決の承認には適用しない。`permission_mode` は次のターン用の設定として通知 |
| モデル・エフォート | `model/list` の全ページを取得し、有効な設定・モデルごとの対応範囲を確認。`turn/start` の `model` / `effort` へ指定。共有型の `low` / `medium` / `high` / `xhigh` / `max` のうち選択モデルが対応する値だけを許可。`set_model` は次のターンから反映し、無効な組は元の組を維持。`null` は既定へ戻す。`model` に指定値と解決できた実際の値を通知 |
| 使用量 | `account/rateLimits/read` / `account/rateLimits/updated` の primary / secondary を `usage` に変換。`usedPercent` → `percent`、Unix 秒の `resetsAt` → ISO、`windowDurationMins` → `windowMinutes`。通知は部分更新として扱い、明示的な枠切れ・クレジット残高追加の通知時は停止 |
| 添付・スラッシュコマンド | 今回は未対応（`supportsAttachments: false`、`listCommands` なし）。`/…` は通常の指示として届く |
| 履歴削除 | `deleteHistory` は未実装。確認した `thread/delete` / `thread/archive` は子スレッドにも及ぶため、共通契約の「そのセッションだけ」を保証できない。Hub 側の履歴だけ削除される |
| Claude 担当への連携依頼 | ルートの `test` / `typecheck` と Hub の依存へ本パッケージを追加し、lockfile を更新する。Web の候補は `model/list` に合わせる（実機確認は `gpt-6.2-sol` / `low`、このモデルは `max` にも対応）。Hub は既存の動的 import で読める。設定は `codex: driver` と対象フォルダの `agent: codex` が必要 |

## 6. 変更履歴

| 日付 | バージョン | 内容 | 提案 |
|---|---|---|---|
| 2026-11-24 | 1 | 初版 | Claude |
| 2026-11-24 | 1 | `packages/shared/package.json` を追加（パッケージ名 `@agentpwa/shared`、`exports` は `./src/protocol.ts`）。型の変更はなし | Claude |
| 2026-11-24 | 2 | 権限モード `full_auto` を追加。実行中の切り替え（`UserAction` の `set_permission_mode`）と、現在のモードの通知（`DriverEvent` の `permission_mode`）を追加 | Claude |
| 2026-11-24 | 3 | 権限モード `auto`（自動承認）を追加。セッションのアーカイブと削除（3.2）と、`AgentDriver.deleteHistory`（任意）を追加 | Claude |
| 2026-11-24 | 4 | エフォート（`EffortLevel` / `EFFORT_LEVELS`、`StartOptions.effort`）を追加。実行中のモデルとエフォートの切り替え（`UserAction` の `set_model`）と、現在の設定の通知（`DriverEvent` の `model`）を追加（3.2。アーカイブと削除は 3.3 に移動） | Claude |
| 2026-11-24 | 5 | `tool` イベントに `paths`（ツールの対象ファイルのパス。省略可）を追加（3章6。ファイルビュワー用） | Claude |
| 2026-11-24 | 6 | `model` イベントに `resolvedModel` / `resolvedEffort`（既定やエイリアスを解決した実際の値。省略可）を追加（3.2）。Codex 側の対応は任意 | Claude |
| 2026-11-24 | 7 | 添付ファイル（`send` の `attachments`、`message` の `attachments`、`AgentDriver.supportsAttachments`）と、スラッシュコマンドの一覧（`AgentDriver.listCommands`、`SlashCommand`）を追加（3.3。アーカイブと削除は 3.4 に移動）。プロジェクトに既定の権限モードが無いときのモードを `ask` から `auto` に変更（`DEFAULT_PERMISSION_MODE`） | Claude |
| 2026-11-24 | 8 | `question` に `questions`（問いごとの見出し・選択肢と説明・複数選択。`QuestionItem` / `QuestionOption`）を、`answer` に `answers`（問いごとの回答）を追加（3.4。アーカイブと削除は 3.5 に移動）。どちらも省略可で、古い形（`prompt` / `options` / `text`）も使える。Codex 側の対応は任意 | Claude |
| 2026-11-24 | 9 | `usage` に `windowMinutes`（枠の長さ（分）。省略可）を追加。UI がバーのメモリ（5時間枠は5等分、週間枠は7等分）に使う。Codex 側の対応は任意 | Claude |
| 2026-11-24 | 10 | サブエージェントの `subagent` イベントと、`message` / `message_delta` / `tool` の `parentToolId`（サブエージェントの中のイベント）を追加（3.6）。どちらも足しただけで、Codex 側の対応は任意 | Claude |
| 2026-11-24 | 11 | 巻き戻しとフォーク（3.7）。`message` に `rewindable`、`DriverEvent` に `rewound`、`UserAction` に `rewind`（`RewindRestore`）、`AgentDriver` に `supportsRewind` / `forkToken` を追加。どれも省略可で、Codex 側の対応は任意 | Claude |
| 2026-11-24 | 12 | `DriverEvent` に `context`（コンテキストの使用量。`usedTokens` と、上限の `windowTokens`（省略可））を追加。UI はペインのモデルとエフォートのボタンの横に使用率を出す。足しただけで、Codex 側の対応は任意 | Claude |
| 2026-11-26 | 13 | `StartOptions.hubGuide`（Hub が AI に伝える Hub の API の説明。セッション ID を含む）と、セッション間のメッセージ（`PeerMessageFrom` / `formatPeerMessage` / `parsePeerMessage`）を追加（3.8）。足しただけで、Codex 側は `hubGuide` を指示に足す対応をお願いしたい（Codex への依頼） | Claude |
