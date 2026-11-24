# AgentPWA

iPhone / iPad / Web から、Claude と Codex の複数セッションを同時に操作する PWA です。返答待ちのセッションを優先して表示します。AI は、このPCと Tailscale でつながった各マシンで動きます。

- 全体構成と担当: [docs/architecture.md](docs/architecture.md)
- Hub と Driver の契約: [docs/protocol.md](docs/protocol.md) / [packages/shared/src/protocol.ts](packages/shared/src/protocol.ts)

## 分担

| 担当 | 範囲 | ガイド |
|---|---|---|
| Claude（Claude Code） | Hub、Web（PWA）、Claude 用 Driver | [CLAUDE.md](CLAUDE.md) |
| Codex | Codex 用 Driver | [AGENTS.md](AGENTS.md) |
| 共同 | 共有の型（`packages/shared`） | [docs/protocol.md](docs/protocol.md) |

## パッケージ

| パス | 内容 |
|---|---|
| `packages/shared` | 共通の型（`@agentpwa/shared`） |
| `packages/hub` | Hub。設定ファイルは保存すると自動で読み直す（port などを除く）。Fastify + WebSocket + SQLite（Node 組み込みの `node:sqlite`）。`127.0.0.1` でだけ待ち受ける |
| `packages/driver-claude` | `claude` CLI をヘッドレス（`claude -p` + stream-json）で動かす Driver |
| `packages/web` | PWA（React + Vite + vite-plugin-pwa） |
| `packages/driver-codex` | Codex 用 Driver（Codex 担当。未作成の間は Hub のフェイク Driver が Codex タブを表示する） |

## 必要なもの

- Node.js 22 以上（現行 LTS。`node:sqlite` を使うため）
- ログイン済みの `claude` CLI（Claude Pro / Max / Team のサブスクリプション）
  - `claude auth status` で `"authMethod": "claude.ai"` になっていること
  - `ANTHROPIC_API_KEY` などの API キーが設定されていると、従量課金を避けるためにセッションを起動しません
- 公開するなら Tailscale（このPCが tailnet に参加していること）

## 起動

```powershell
npm install
```

初回は Hub の設定ファイルを作ります。Hub を一度起動すると `%USERPROFILE%\.agentpwa\config.json` が自動で作られるので、`folders`（起動してよいフォルダ）と `allowedUsers`（許可する Tailscale ユーザー）を書き足してください。書き方は [packages/hub/config.example.json](packages/hub/config.example.json) を参照してください。

### 開発（Hub と Web を一緒に起動）

```powershell
npm run dev
```

- Hub: http://127.0.0.1:8787 （API と WebSocket）
- Web: http://127.0.0.1:5173 （Vite。`/api` と `/ws` を Hub に中継する）

ブラウザで http://127.0.0.1:5173 を開きます。Hub は `tsx watch` でソースの変更を拾って再起動します。

### ふだん使い（ビルドして Hub だけで配信）

```powershell
npm start
```

Web をビルドし（`packages/web/dist`）、Hub が http://127.0.0.1:8787 で API と画面の両方を配信します。`tailscale serve` で公開するのはこちらです。

### テスト

```powershell
npm test
```

Hub（状態遷移・並べ替え・既読・再起動後の再開・認証・許可リスト）と Claude Driver（stream-json の変換・許可要求の変換・フィクスチャ）の単体テストを実行します。型の確認は `npm run typecheck` です。

## 設定ファイル（`%USERPROFILE%\.agentpwa\config.json`）

| キー | 内容 | 既定 |
|---|---|---|
| `port` | Hub の待ち受けポート（`127.0.0.1` 固定） | `8787` |
| `machineName` | 一覧に出すマシン名 | PC 名 |
| `allowedUsers` | 許可する Tailscale ユーザー（`Tailscale-User-Login` の値） | `[]`（tailscale serve 経由はすべて拒否） |
| `allowLocalhost` | このPCのブラウザから `127.0.0.1` で直接開くのを許すか | `true` |
| `folders` | プロジェクト＝セッションを起動してよいフォルダ。`name`、絶対パスの `path`、使う AI の `agent`（`"claude"` / `"codex"`、省略時は `"claude"`）。パスは完全一致のみ | `[]` |
| `claudePath` | `claude` CLI のパス | PATH と `~\.local\bin` を探す |
| `codex` | `"fake"`（フィクスチャを流す表示確認用）か `"driver"`（`@agentpwa/driver-codex` を使う） | `"fake"` |

- 別の場所の設定ファイルを使うときは、環境変数 `AGENTPWA_CONFIG` にパスを入れます。`AGENTPWA_PORT` でポートだけ上書きできます（開発時は Vite の中継先も同じ変数で変わります）。
- セッションの履歴は設定ファイルと同じフォルダの `hub.db`（SQLite）に保存されます。Hub を再起動しても履歴は残り、止まったセッションは「再開」か、次の送信で `claude --resume` により続きから再開します。

## tailscale serve で公開する

インターネットには公開しません（`tailscale funnel` は使いません）。tailnet の中の自分の端末からだけ開けるようにします。

1. Tailscale の管理画面で MagicDNS と HTTPS 証明書を有効にしておきます。
2. 設定ファイルの `allowedUsers` に、自分の Tailscale のログイン名（例: `you@example.com`）を入れて Hub を起動します（`npm start`）。
3. Hub のポートを tailnet に HTTPS で公開します。

   ```powershell
   tailscale serve --bg 8787
   ```

   `https://<このPCの名前>.<tailnet名>.ts.net/` が `http://127.0.0.1:8787` に中継されます。状態は `tailscale serve status` で確認できます。

4. iPhone / iPad の Safari でその URL を開き、共有メニューの「ホーム画面に追加」で PWA としてインストールします。

公開をやめるとき:

```powershell
tailscale serve --https=443 off
```

補足:

- serve は tailnet のユーザーの端末からのリクエストに `Tailscale-User-Login` ヘッダーを付けます。Hub はこれが `allowedUsers` に入っているかを確認し、それ以外は 403 にします。ヘッダーの無いリクエストは、Host が `127.0.0.1` / `localhost` のとき（このPCから直接）だけ通します。
- さらに絞るなら、Tailscale の ACL で、このPCの 443 番に届く端末を自分の端末に限定してください。
- `tailscale serve` の設定はこのPCの公開範囲を変える操作です。実行するときは内容を確認してから行ってください。

## Codex タブ（表示確認用のフェイク Driver）

Codex 用 Driver は Codex の担当です（[GS-Bacon/AgentPWA#1](https://github.com/GS-Bacon/AgentPWA/issues/1)）。それができるまで、Hub は [packages/hub/fixtures/codex](packages/hub/fixtures/codex) の JSONL（`DriverEvent` 列）を順に流すフェイク Driver で Codex タブを表示します。許可要求・質問・ターン終了のところでは、画面からの操作を待ってから続きを流します。

`packages/driver-codex` ができたら、`createCodexDriver()` を export したうえで、設定ファイルの `codex` を `"driver"` にすると Hub がそれを使います。

## Claude Driver を単体で試す

Hub なしで Driver を動かし、`DriverEvent` を JSONL で確認できます。

```powershell
npm run try -w @agentpwa/driver-claude -- --cwd C:\path\to\folder --model haiku "最初の指示"
```

標準入力に `UserAction` を1行1件の JSON で入れます（例: `{"type":"approve","requestId":"toolu_...","decision":"allow"}`）。実セッションから記録したフィクスチャが [packages/driver-claude/fixtures](packages/driver-claude/fixtures) にあります（承認・質問・中断）。
