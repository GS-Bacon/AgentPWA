# Codex Driver

`codex app-server` の stdio を使う `@agentpwa/shared` の `AgentDriver` 実装です。文書を確認し、**codex-cli 0.171.0-alpha.13 / Windows / Node.js 24.22.1** で認証、承認、質問、中断を実機確認しました（2026-11-24）。

```ts
import { createCodexDriver } from '@agentpwa/driver-codex';

const driver = createCodexDriver({ codexPath: 'codex' });
const auth = await driver.checkAuth();
if (!auth.ok) throw new Error(auth.detail);
const session = await driver.start({
  sessionId: 'hub-session-id',
  cwd: '/path/to/project',
  permissionMode: 'ask',
}, console.log);
await session.send({ type: 'send', text: 'このプロジェクトを説明してください' });
await session.stop();
```

## 課金経路の制限

- `OPENAI_API_KEY`、`CODEX_API_KEY`、Azure のキー、独自の接続先を指定する環境変数があれば、プロセスを起動する前に拒否します。値は表示しません。
- `config/read` の有効な設定と `account/read` を調べ、標準の OpenAI プロバイダーと ChatGPT ログインの組だけを認めます。OpenAI プロバイダーの上書き、API キー、Bedrock、GCP、未ログイン、不明な認証は開始できません。プロジェクト固有の設定も確認します。
- Hub を経由せず `start()` を直接呼んでも検査します。送信、追加指示、承認の許可、質問への回答の前にも再検査します。認証変更の通知が来たら停止します。
- 推論の継続前に `account/rateLimits/read` を呼びます。**`ordinaryUsageAllowed: true`、残り利用枠あり、`credits.hasCredits: false`** を確認できる場合だけ進めます。枠切れ、追加クレジット残高あり、クレジット無制限、不明・取得失敗の場合は拒否します。このため、追加クレジットを持つアカウントでも、この Driver からは利用できません。
- `serviceTier: "default"` を明示します。キーへのフォールバック、クレジット購入、利用枠リセットの消費、ログイン変更、設定ファイルの書き換えは行いません。

これは接続時点の認証・利用枠に基づく制限です。app-server には、この Driver が確認した範囲で課金額をゼロに固定する要求項目はありません。別の端末からの契約・残高変更まで原子的に固定することはできません。プランの利用枠そのものは消費します。

## 対応

| 操作 | 実装 |
|---|---|
| 初期化 | `initialize`（`experimentalApi: true`）→ `initialized`。JSONL の JSON-RPC。wire では `jsonrpc` ヘッダーを省く |
| 開始・再開 | `thread/start` / `thread/resume` → `thread.id` をすぐ `resume_token` で通知。指示があるときだけ `turn/start` |
| 次の指示・実行中の追加指示 | アイドルでは `turn/start`、実行中は `turn/steer`（`expectedTurnId` つき）。送信を直列化し、開始応答の後に `turn/started` を待つ |
| 中断 | `turn/interrupt`。`turn/completed` の `interrupted` で `idle` に戻る。プロセスは次の指示に使える |
| 終了 | stdio を閉じて終了を待つ。残る場合は自分が起動したプロセスのツリーを終了し、最後に `stopped` |
| 承認 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。同時に複数あれば全部解決するまで待機する |
| ファイル差分 | `item/started` の `fileChange.changes` を承認に添える。新規・削除ファイルの本文を unified diff に変換し、追加・削除行数を数える。移動先も `tool.paths` に含める |
| 質問 | `item/tool/requestUserInput`（旧名 `tool/requestUserInput` も受信）。複数の問い・選択肢の説明を v8 の `questions` に入れ、回答を元の質問 ID ごとに返す。秘密情報の質問は保存せず拒否する |
| ツールのパス | ファイル変更、画像表示、`commandActions` の `read.path`。シェル文字列からパスを推測しない |
| 返答 | `item/agentMessage/delta` → 同じ ID の `message`。中断・停止で残った断片も確定する |
| 使用量 | `account/rateLimits/read` と `account/rateLimits/updated`。使用率、リセット時刻、`windowDurationMins` を通知する |

承認の選択肢はサーバーの `availableDecisions` に限定します。`allow` は `accept`、`allow_session` は `acceptForSession`、`deny` は `decline`（なければ `cancel`）です。ファイル承認に選択肢指定がない場合は3種類とも使えます。補足文 `note` を返す欄はないため、理由を通知し、追加指示として送るよう案内します。別クライアント等で解決された要求は、決定が通知に含まれないため、承認カードを保守的に `deny` として閉じます。

## 権限モード

| 共通モード | approvalPolicy | sandbox | approvalsReviewer |
|---|---|---|---|
| `ask` | `untrusted` | `read-only` | `user` |
| `auto_edit` | `on-request` | `workspace-write` | `user` |
| `auto` | `on-request` | `workspace-write` | `auto_review` |
| `full_auto` | `never` | `danger-full-access` | `user` |
| `plan` | `never` | `read-only` | `user` |

`ask` でも、Codex が信頼する読み取りコマンドは確認なしで実行されることがあります。`auto_edit` は作業フォルダ内の編集とサンドボックス内で許されたコマンドを自動で実行し、追加権限を人に確認します。`auto` の追加権限は Codex の自動レビューへ渡します。`plan` では `collaborationMode: plan` も指定し、変更の権限昇格を許可しません。

`set_permission_mode` は次の `turn/start` から反映します。現在のターンと、すでに表示した承認カードには適用しません。起動時に `auto` を反映できないサーバーでは、理由を通知して `ask` に落とします。古い版では推論前の利用枠検査も通らない場合があるため、確認済みの版を使ってください。`full_auto` のフォルダごとの利用許可は Hub が検証する契約です。

## モデルとエフォート

`model/list` をページ末尾まで取得し、選べるモデルとモデルごとのエフォートを検証します。既定はプロジェクトの有効な設定（設定がなければカタログの既定）です。`low` / `medium` / `high` / `xhigh` / `max` のうち、選んだモデルが対応するものを受け付けます。共有型にない `ultra` は扱いません。実機では `gpt-6.2-sol` と `low` を使用しました。

`set_model` は次のターンから反映します。省略は維持、`null` は既定への復帰です。無効な組み合わせは理由を通知して元の組を維持します。`model` イベントには指定値と、分かる場合に実際のモデル・エフォートを含めます。

## 未対応と担当外への依頼

- 添付ファイルは `supportsAttachments: false`。送られた場合は例外にします。
- スラッシュコマンドの一覧・実行は未実装です。`/…` は通常の指示としてモデルへ届きます。
- `deleteHistory` は未実装です。この版の `thread/delete` / `thread/archive` は子スレッドにも及び、共通契約の「そのセッションだけ」を保証できないためです。Hub の削除では Codex 側の履歴が残ります。
- MCP の elicitation 等、共有型に安全に変換できない未知のサーバー要求は JSON-RPC エラーで拒否し、UI に理由を出します。
- Hub / Web / 共有型 / ルートの設定は担当範囲外として変更していません。Claude 担当へ、ルートの `test` / `typecheck` への本パッケージ追加、Hub の依存への `@agentpwa/driver-codex` 追加、`npm install` による lockfile 更新を依頼します。Web のモデル・エフォート候補は `model/list` と整合させる必要があります。

## 起動と検証

ルートで npm workspaces のリンクを用意してから実行します。Windows の npm インストール版が `.cmd` しか公開していない場合は、シェルを介さず実行できる `codex.exe` を `codexPath` / `--codex-path` に指定してください。

```powershell
npm run typecheck -w @agentpwa/driver-codex
npm test -w @agentpwa/driver-codex
# 推論・スレッド作成なしの認証確認
npm run probe -w @agentpwa/driver-codex
# 標準入力を開いたまま、1行1件の UserAction を入力する
npm run try -w @agentpwa/driver-codex -- --cwd C:\path\to\project --mode ask
```

```json
{"type":"send","text":"構成を説明してください"}
{"type":"approve","requestId":"rpc:number:0","decision":"allow"}
{"type":"answer","requestId":"rpc:number:1","text":"青","answers":["青"]}
{"type":"interrupt"}
```

Hub は既存の動的 import で読み込めます。Hub の設定を `"codex": "driver"`、対象フォルダを `"agent": "codex"` にすると使用します（設定の変更は利用者が行います）。既定の `"codex": "fake"` は表示確認用です。

通常のテストは CLI・認証情報・ネットワークを使いません。実 CLI の手動テストは次のスクリプトに分けています。こちらは ChatGPT の利用枠を消費します。

作業時の追加確認では、リポジトリ全体の型チェックと既存の Claude Driver のテストも通過しました。既存 Hub のテストは 93 件通過、1 件スキップ、3 件失敗でした。失敗は `test/projects.test.ts` の Windows の一時パスにある `openai.codex` と `OpenAI.Codex` の文字列比較です。Hub は本 Driver を使わないテストで、担当外のため変更していません。

```powershell
# 承認 → 質問 → 中断を実行する。既定は gpt-6.2-sol / low
npx tsx packages/driver-codex/scripts/record-fixtures.ts
# 内容を確認後、ID と実行環境のパスを匿名化して fixtures に書き出す
npx tsx packages/driver-codex/scripts/prepare-fixtures.ts
```

記録先は `.local/recordings`、作業先は `.local/scenarios/<時刻>` です。自動許可するのはその作業先の `sample.txt` 新規作成と、そのファイルの `Get-Content` だけです。他の承認は拒否します。`fixtures/*.jsonl` はこの Driver で採取した実セッションのイベント列で、ID とローカルパスだけを匿名化しています。認証の通信・トークン・メールアドレスは記録していません。

参照: [公式 app-server 仕様](https://developers.openai.com/codex/app-server/)、[設定リファレンス](https://developers.openai.com/codex/config-reference/)。wire の確認には手元で `codex app-server generate-ts --experimental --out <確認用フォルダ>` を実行しました。生成物は `.local` 内の検証用で、パッケージには含めません。
