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

### 3.1 権限モードの切り替え

- 起動したら、実際に使っているモードを `permission_mode` で送る（対応がなく `ask` に落とした場合は `ask` を送る）。
- `set_permission_mode` を受けたら、エージェントに反映してから `permission_mode` を送る。反映できなければ `error`（`fatal: false`）を送り、`permission_mode` は送らない（元のモードのまま）。
- どの状態（`running` / `idle` / `waiting_*`）でも受け付ける。実行中のターンにすぐ効かないエージェントは、次のターンから反映し、そのことを `permission_mode` の送信時点で反映済みとみなしてよい（対応表に書く）。
- エージェント自身がモードを変えたとき（例: Claude の計画モードの終了）も `permission_mode` を送る。
- 切り替えても、すでに出ている `approval_request` は自動で解決しない。ユーザーが個別に決める。
- `full_auto` は、Hub が「フォルダの許可リストで `full_auto` を許可したフォルダ」のセッションにだけ渡す。それ以外のセッションへの `set_permission_mode`（`full_auto`）は Hub が拒否し、Driver には届かない。
- `auto`（自動承認）はフォルダの制限なしで使える。危険と判定された操作はエージェント側で止まるため、`full_auto` とは扱いを分ける。

### 3.2 セッションのアーカイブと削除

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
| 許可要求 | `--permission-prompt-tool stdio` で、CLI から標準出力に `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name","input","tool_use_id",…}}` が届く。これを `approval_request`（`requestId` = tool_use_id）に変換する。決定は標準入力に `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":…}}}`（拒否は `{"behavior":"deny","message":…}`）で返す。CLI が `control_cancel_request` で取り下げたら、`approval_resolved`（deny）にする。MCP ツールは使わない（SSH 先の CLI から届かないため。docs/architecture.md の 6.4） |
| allow_session | CLI には渡さず Driver が覚える。シェル（Bash / PowerShell）はコマンドの先頭の語ごと、それ以外はツール名ごとに、以後の問い合わせを自動で許可する |
| 質問 | `AskUserQuestion` の許可要求を `question` に変換する（選択肢は質問が1つのときだけ `options` に入れる）。回答は `updatedInput.answers = {質問文: 回答}` で返す |
| プランの承認 | `ExitPlanMode` の許可要求を `approval_request`（`kind: 'other'`、`command` にプラン本文、choices は allow / deny）にする |
| 再開 | `--resume <session_id>`（`resume_token` = system/init の session_id）。Hub 再起動後や CLI が落ちた後は、次の送信で起動し直す |
| 中断 | 標準入力に `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` を書く。5 秒以内に result が来なければプロセスを終了し、次の送信で `--resume` する。どちらも `status: idle`（reason: 中断しました）にする |
| 権限モード（起動時） | `--permission-mode`: `ask`→`default`、`auto_edit`→`acceptEdits`、`auto`→`auto`、`full_auto`→`bypassPermissions`、`plan`→`plan`。`full_auto` へ後から切り替えられるよう、常に `--allow-dangerously-skip-permissions` を付ける |
| 権限モード（実行中） | プロセスが動いていれば、標準入力へ `{"type":"control_request","request_id":…,"request":{"subtype":"set_permission_mode","mode":…}}` を送る。`control_response` の success で反映とみなす（実行中のターンにもすぐ効く）。error なら `error`（`fatal: false`）を送り、元のモードのままにする。プロセスが止まっていれば、次の起動の `--permission-mode` に使う |
| 自動承認（`auto`） | Claude Code の auto モード（安全判定の分類器が操作ごとに許可を決める）を使う。プランやモデルの条件で使えないときは、CLI が返すエラーを `error`（`fatal: false`）で知らせて元のモードのままにする。分類器が止めた操作が `can_use_tool` で届いたときは、通常どおり `approval_request` にする |
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
