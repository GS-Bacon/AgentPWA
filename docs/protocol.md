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

### 3.4 セッションのアーカイブと削除

- アーカイブと削除は Hub が扱う。Driver に `UserAction` は届かない。
- Hub は、動いているセッション（`stopped` 以外）をアーカイブ・削除する前に `stop()` を呼ぶ。アーカイブを戻したセッションは `stopped` のままで、次に送信したときに `resumeToken` で再開する。
- 削除では、Hub が自分の記録（セッションとイベント）を消したあと、Driver が `deleteHistory` を実装していれば、`resume_token` で受け取った値を渡して呼ぶ。失敗しても Hub 側の削除は取り消さず、Web に失敗を知らせる。
- `deleteHistory` は、そのセッションの履歴だけを消す。同じフォルダの他のセッションや、エージェントの設定には触れない。

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
| 起動 | `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-mode <mode> --permission-prompt-tool stdio --allow-dangerously-skip-permissions`。子プロセスは起動役（`local` / `ssh`）を通して起動する（6.6 の v4 までは Driver 内に起動役を持つ）。プロセスは最初の送信で起動し、ターンが終わっても標準入力を開いたまま次の指示を待つ |
| 送信 | 標準入力に `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}` を1行で書く。実行中に送ったものは CLI 側で次のターンに回る |
| 添付ファイル | PNG / JPEG / GIF / WebP（3.75MB まで）は `content` を配列にして `{"type":"image","source":{"type":"base64","media_type":…,"data":…}}` で渡す。それ以外は Hub のPCの一時フォルダ（`<tmp>/agentpwa-attachments/<sessionId>/`）に保存し、本文の後ろにパスを書き足して Read ツールで読ませる。このフォルダは起動時に `--add-dir` で渡すので、確認なしで読める。SSH 先のマシン（起動役を差し替えたとき）では画像だけ受け付ける |
| スラッシュコマンド | 一覧は、CLI を短く起動して制御要求 `{"subtype":"initialize"}` を送り、応答の `commands`（`name` / `description` / `argumentHint`）を使う（API は呼ばない）。`__` で始まる内部用は除く。実行は本文をそのまま送る（`/context` などの出力は、モデル `<synthetic>` の assistant メッセージで届く）。ただし引数つきの `/model <名前>` と `/effort <段階>` は CLI に送らず、`set_model` と同じ処理にする（Hub と Web の表示をそろえるため。`default` / `auto` は既定に戻す） |
| 許可要求 | `--permission-prompt-tool stdio` で、CLI から標準出力に `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name","input","tool_use_id",…}}` が届く。これを `approval_request`（`requestId` = tool_use_id）に変換する。決定は標準入力に `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":…}}}`（拒否は `{"behavior":"deny","message":…}`）で返す。CLI が `control_cancel_request` で取り下げたら、`approval_resolved`（deny）にする。MCP ツールは使わない（SSH 先の CLI から届かないため。docs/architecture.md の 6.4） |
| allow_session | CLI には渡さず Driver が覚える。シェル（Bash / PowerShell）はコマンドの先頭の語ごと、それ以外はツール名ごとに、以後の問い合わせを自動で許可する |
| 質問 | `AskUserQuestion` の許可要求を `question` に変換する（選択肢は質問が1つのときだけ `options` に入れる）。回答は `updatedInput.answers = {質問文: 回答}` で返す |
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
| 履歴の削除（`deleteHistory`） | `~/.claude/projects/<cwd の英数字以外を - に置き換えた名前>/<session_id>.jsonl` と、同名のフォルダ（あれば）を消す。`claude --resume` の一覧からも消える |
| 認証の確認 | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` があれば `api_key`。無ければ `claude auth status`（JSON）の `authMethod` を見て、`claude.ai` / `oauth_token` は `subscription`、`api_key` / `api_key_helper` / `third_party` は `api_key`。起動後も system/init の `apiKeySource` が `none` 以外なら、エラー（fatal）を出して止める |
| 使用量 | `rate_limit_event` の `unifiedWindows.five_hour` / `seven_day` の utilization を `usage`（「セッション枠（5時間）」「週間」）にする |

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
- スラッシュコマンド: 使えるコマンドの一覧が app-server から取れるなら `listCommands(cwd)` を実装する
- 権限モードの既定が `DEFAULT_PERMISSION_MODE`（`auto`）になりました。`auto` に当たる設定が無ければ、3章5のとおり `ask` に落としてください

### Codex への依頼（セッションの削除）

- `deleteHistory` を実装するか決めて、対応表に書いてください。app-server にスレッドを消す（またはアーカイブする）メソッドがあれば使い、なければ実装しなくてよい（Hub の記録だけ消える）。

### Codex（`codex app-server`）— Codex 担当

| プロトコル | Codex app-server 側 |
|---|---|
| 起動 | `thread/start` → `turn/start` |
| 許可要求 | サーバーからの承認リクエスト（メソッド名は公式ドキュメントで確認する） |
| 再開 | `thread/resume`（`resume_token` = thread.id） |
| 中断 | `turn/interrupt` |
| 実行中の追加指示 | `turn/steer` |

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
