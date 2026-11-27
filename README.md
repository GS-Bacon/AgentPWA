# AgentPWA

iPhone / iPad / Web から、PC で動く Claude Code と Codex の複数セッションを同時に操作する PWA です。返答待ちのセッションを優先して表示します。

- PC で動いている `claude` CLI（と `codex` CLI）を、スマホやタブレットから操作できます（許可・質問への回答、モデルの切り替え、ファイルの表示など）。
- 使うのは、ログイン済みの CLI です。Claude は Pro / Max / Team のサブスクリプション、Codex は ChatGPT のプランの枠で動きます。API キーは使いません（従量課金になりません）。
- 公開は Tailscale の tailnet の中だけです（`tailscale serve`）。インターネットには公開しません。

## できること

- **セッションの一覧**: プロジェクト（作業フォルダと AI の組）ごとにまとめ、許可待ち・質問待ち・未読を先頭に出します。ピン止め、「未読にする」、「あとで返信」の印を付けられ、全端末で共有します。待ちの件数をアプリアイコンのバッジに出します（Web Push の通知はまだありません）。
- **ペイン**: iPad / Web ではペインを何枚でも並べられます。見出しをドラッグして分割・入れ替えでき、並びは端末ごとに自動で復元します。iPhone は1画面ずつ遷移します。
- **操作**: 許可・質問への回答、中断（Esc）、権限モード（毎回確認 / 編集は自動 / 自動承認 / すべて自動 / 計画のみ）、モデルとエフォートの切り替え、コンテキストと使用量の表示。
- **入力欄**: ファイルや画像の添付、`/` でスラッシュコマンド、`@` でファイル、`#` でプロジェクトごとの候補（案件の記号など）を補完します。
- **会話**: ツールの呼び出しを1行にまとめて表示し、サブエージェントの中身はサブペインに出します。送った発言のフォーク・巻き戻し・編集・コピーができます（Claude）。
- **ファイルビュワー**: 会話の中のパスやリンクから、HTML のスライド・画像・PDF・Markdown・ソースを PWA の中で開きます（プロジェクトの下と、パソコン版 Google ドライブなど）。
- **セッションどうしの連携**: セッションの中の AI が、新しいセッションを作ったり、ほかのセッション（Claude でも Codex でも）にメッセージを送ったりできます。
- **アーカイブと削除**、Hub を再起動しても続きから再開できる履歴の保存。

詳しい仕様は [docs/architecture.md](docs/architecture.md) にあります。

## 必要なもの

- **Node.js 22.13 以上**（現行の LTS）: https://nodejs.org/
- **Claude Code**（`claude` CLI）にログインしていること: https://docs.claude.com/claude-code
  - `ANTHROPIC_API_KEY` などの API キーが設定されていると、従量課金を避けるためにセッションを起動しません。
- **Tailscale**（スマホやタブレットから使うとき）: このPCと端末の両方に入れて、同じ tailnet にログインします。https://tailscale.com/download
  - Tailscale の管理画面で **MagicDNS** と **HTTPS 証明書**を有効にしておきます（無効なら、セットアップの途中で有効にするための URL が出ます）。

Windows で動作を確認しています。macOS / Linux でも動く作りですが、自動起動の設定はしません。

## インストール

```sh
git clone https://github.com/GS-Bacon/AgentPWA.git
cd AgentPWA
npm run setup
```

`npm run setup` が、次のことを順に行います。何度実行してもかまいません（済んでいる手順は飛ばします）。

1. 必要なもの（Node.js、`claude` CLI とログイン、Tailscale）を確かめる
2. 設定ファイル（`~/.agentpwa/config.json`）を作り、次の値を自動で入れる
   - 許可するユーザー: このPCにログインしている Tailscale ユーザー
   - プロジェクトを作れる場所: ホームフォルダ
3. 画面（Web）をビルドする
4. `tailscale serve` で tailnet の中に公開する（確認してから）
5. ログオン時に Hub を自動で起動する（Windows。確認してから。スタートアップに登録する）

確認にすべて「はい」と答えるときは `npm run setup -- --yes` です。

終わると、開く URL が表示されます。

- このPCから: http://127.0.0.1:8787/
- iPhone / iPad: `https://<このPCの名前>.<tailnet名>.ts.net/`。Safari で開き、共有メニューの「ホーム画面に追加」でアプリとして使えます。

あとは画面の「新しいプロジェクト」で作業フォルダを選べば、セッションを始められます。

### Codex を使う

Codex のセッションは、初期設定では表示確認用のフェイク（記録したやりとりを流すだけ）になっています。本物の Codex を使うときは次のようにします。

1. Codex（`codex` CLI か Codex のデスクトップアプリ）を入れ、ChatGPT のアカウントでログインしておく（API キーや独自の接続先が設定されていると、課金を避けるためにセッションを起動しません）
2. 設定ファイル（`~/.agentpwa/config.json`）の `codex` を `"driver"` にして、Hub を再起動する
3. 画面の「新しいプロジェクト」で、AI に Codex を選んでプロジェクトを作る

同じフォルダを、Claude と Codex それぞれのプロジェクトとして登録できます。Codex 側の対応状況と制約は [packages/driver-codex/README.md](packages/driver-codex/README.md) にあります。

### ほかの端末・ほかの人を許可する

同じ Tailscale ユーザーでログインした端末は、そのまま開けます。別の Tailscale ユーザーは、開こうとすると「許可待ち」になります。すでに許可されている端末か、このPCのブラウザ（http://127.0.0.1:8787/）で **設定 → アクセス** を開き、「許可」を押してください。許可したユーザーは、この Hub を通じてこのPCで AI を動かせるので、信頼できる人だけにしてください。

### 起動と停止

- 自動起動を登録した場合は、ログオン時に最小化したウィンドウ「AgentPWA Hub」で動きます。ウィンドウを閉じると止まります。ログは `~/.agentpwa/hub.log` です。
- 手で起動するときは、このフォルダで `npm start` です。
- 自動起動をやめるときは、スタートアップフォルダ（エクスプローラーで `shell:startup`）の `AgentPWA Hub.cmd` を消します。
- tailnet への公開をやめるときは `tailscale serve --https=443 off` です。

### 更新

```sh
git pull
npm run setup
```

## 設定ファイル（`~/.agentpwa/config.json`）

ふだんは画面から設定できるので、編集しなくてかまいません。保存すると Hub が自動で読み直します（`port`・`claudePath`・`codex`・`codexPath` を除く）。書き方の例: [packages/hub/config.example.json](packages/hub/config.example.json)

| キー | 内容 | 既定 |
|---|---|---|
| `port` | Hub の待ち受けポート（`127.0.0.1` 固定） | `8787` |
| `machineName` | 一覧に出すマシン名 | PC 名 |
| `allowedUsers` | 許可する Tailscale ユーザー（`Tailscale-User-Login` の値）。画面の「設定 → アクセス」で足したり消したりできる | このPCの Tailscale ユーザー（空なら起動時に自動で入れる） |
| `allowLocalhost` | このPCのブラウザから `127.0.0.1` で直接開くのを許すか | `true` |
| `folders` | プロジェクト＝セッションを起動してよいフォルダ。`name`、絶対パスの `path`、使う AI の `agent`（`"claude"` / `"codex"`、省略時は `"claude"`）。パスは完全一致のみ。同じ `path` を `agent` を変えて2つ書けば、同じフォルダを Claude と Codex の両方のプロジェクトにできる（同じ AI で2つは不可）。任意で `defaultPermissionMode`（新規セッションの既定の権限モード。`ask` / `auto_edit` / `auto` / `full_auto` / `plan`、省略時は `auto`）と `allowFullAuto`（「すべて自動」を許すか。省略時は `false`。`false` のプロジェクトでは Hub が `full_auto` を拒否する）、`color`（一覧とペインの色） | `[]`（画面の「新しいプロジェクト」で足す） |
| `projectRoots` | 画面からプロジェクトを作ってよいルートフォルダ（絶対パスの配列）。この下のフォルダだけを選べ、新しいフォルダも作れる（`git init` も選べる）。シンボリックリンクを解決したうえで外に出ていないかを確かめる | 新しく作った設定ファイルではホームフォルダ |
| `viewerRoots` | プロジェクトのフォルダのほかに、ファイルビュワーで開いてよいフォルダ（絶対パスの配列）。パソコン版 Google ドライブは自動で加わる | `[]` |
| `agentDefaults` | AI ごとの既定のモデルとエフォート（例: `{ "claude": { "model": "opus", "effort": "high" } }`）。新しいセッションでモデル・エフォートを選ばなかったとき（と、ペインのメニューで「既定」に戻したとき）に使う。画面の「設定 → エージェント」で変えられる | 指定なし（CLI の既定） |
| `claudePath` | `claude` CLI のパス | PATH と `~/.local/bin` を探す |
| `codex` | `"driver"`（本物の Codex を `@agentpwa/driver-codex` で動かす）か `"fake"`（フィクスチャを流す表示確認用）。変えたら Hub の再起動が要る | `"fake"` |
| `codexPath` | `codex` CLI のパス（`codex: "driver"` のとき） | PATH を探し、無ければ Codex デスクトップアプリのいまの版の `codex.exe` を使う。アプリが更新されて場所が変わっても、次のセッション開始で追いかける |

- 別の場所の設定ファイルを使うときは、環境変数 `AGENTPWA_CONFIG` にパスを入れます。`AGENTPWA_PORT` でポートだけ上書きできます。
- セッションの履歴は設定ファイルと同じフォルダの `hub.db`（SQLite）に保存されます。Hub を再起動しても履歴は残り、止まったセッションは「再開」か、次の送信で `claude --resume` により続きから再開します。

## セキュリティ

- Hub は `127.0.0.1` でだけ待ち受けます。外からは `tailscale serve` が中継し、tailnet の中の端末からしか届きません（`tailscale funnel` は使いません）。
- serve が付ける `Tailscale-User-Login` ヘッダーが `allowedUsers` に入っているかを確かめ、それ以外は拒否します。ヘッダーの無いリクエストは、Host が `127.0.0.1` / `localhost` のとき（このPCから直接）だけ通します。
- さらに絞るなら、Tailscale の ACL で、このPCの 443 番に届く端末を自分の端末に限定してください。
- 詳しくは [docs/architecture.md](docs/architecture.md) の「7. セキュリティ」を見てください。

## 開発

- 全体構成と担当: [docs/architecture.md](docs/architecture.md)
- Hub と Driver の契約: [docs/protocol.md](docs/protocol.md) / [packages/shared/src/protocol.ts](packages/shared/src/protocol.ts)

### 分担

Claude（Claude Code）と Codex で分担して開発しています。

| 担当 | 範囲 | ガイド |
|---|---|---|
| Claude（Claude Code） | Hub、Web（PWA）、Claude 用 Driver | [CLAUDE.md](CLAUDE.md) |
| Codex | Codex 用 Driver | [AGENTS.md](AGENTS.md) |
| 共同 | 共有の型（`packages/shared`） | [docs/protocol.md](docs/protocol.md) |

### パッケージ

| パス | 内容 |
|---|---|
| `packages/shared` | 共通の型（`@agentpwa/shared`） |
| `packages/hub` | Hub。Fastify + WebSocket + SQLite（Node 組み込みの `node:sqlite`）。`127.0.0.1` でだけ待ち受ける。`src/setup.ts` が `npm run setup` |
| `packages/driver-claude` | `claude` CLI をヘッドレス（`claude -p` + stream-json）で動かす Driver。返答待ちのまま 20 分使われないプロセスは終わらせ、次の送信で `--resume` する |
| `packages/web` | PWA（React + Vite + vite-plugin-pwa） |
| `packages/driver-codex` | `codex app-server` を動かす Codex 用 Driver（Codex 担当）。ChatGPT のプランの枠でだけ動かす |

### 開発用の起動（Hub と Web を一緒に起動）

```sh
npm install
npm run dev
```

- Hub: http://127.0.0.1:8787 （API と WebSocket）
- Web: http://127.0.0.1:5173 （Vite。`/api` と `/ws` を Hub に中継する）

ブラウザで http://127.0.0.1:5173 を開きます。Hub は `tsx watch` でソースの変更を拾って再起動します。

### テスト

```sh
npm test
npm run typecheck
```

### Codex のフェイク Driver（表示確認用）

設定ファイルの `codex` が `"fake"`（既定）のとき、Hub は [packages/hub/fixtures/codex](packages/hub/fixtures/codex) の JSONL（`DriverEvent` 列）を順に流すフェイク Driver で Codex のセッションを表示します。許可要求・質問・ターン終了のところでは、画面からの操作を待ってから続きを流します。Codex にログインしていなくても画面を確かめられます。設定タブの「エージェント」には「表示確認用のフェイク Driver」と出ます。

### Claude Driver を単体で試す

Hub なしで Driver を動かし、`DriverEvent` を JSONL で確認できます。

```sh
npm run try -w @agentpwa/driver-claude -- --cwd /path/to/folder --model haiku "最初の指示"
```

標準入力に `UserAction` を1行1件の JSON で入れます（例: `{"type":"approve","requestId":"toolu_...","decision":"allow"}`）。実セッションから記録したフィクスチャが [packages/driver-claude/fixtures](packages/driver-claude/fixtures) にあります（承認・質問・中断）。

Codex の Driver も同じように `npm run try -w @agentpwa/driver-codex` で試せます（使い方は [packages/driver-codex/README.md](packages/driver-codex/README.md)）。

## ライセンス

[MIT](LICENSE)
