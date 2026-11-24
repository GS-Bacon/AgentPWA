# AgentPWA アーキテクチャ

iPhone / iPad / Web から、Claude と Codex の複数セッションを同時に操作する PWA です。返答待ちのセッションを優先して表示します。

- 画面イメージ: https://claude.ai/artifact/4jQsp81AzpKfSG8StXn73Q （ダークテーマ）
- プロトコル: [docs/protocol.md](protocol.md)

## 1. 全体構成

```
 iPhone / iPad / ブラウザ (PWA)
        │ HTTPS + WebSocket（tailscale serve 経由、tailnet 内のみ）
        ▼
 ┌──────────── Hub（このPC）────────────┐
 │ 127.0.0.1 で待ち受け                  │
 │ セッション管理 / SQLite / Web Push    │
 │ ├─ driver-claude ─ claude -p（ヘッドレス）
 │ └─ driver-codex  ─ codex app-server   │
 └──────────────┬───────────────────────┘
                │ WebSocket over Tailscale（後のフェーズ）
       Runner（他マシン）: 同じ Driver を載せた小さな常駐プロセス
```

- **課金**: どちらのエージェントも、ユーザー自身がログインした CLI をそのまま動かします。Claude は Pro/Max、Codex は ChatGPT プランの枠で動かします。API キーによる従量課金は使いません（Claude Agent SDK を使わないのはこのためです）。
- **公開範囲**: `tailscale serve` だけで公開します。インターネットに公開する `tailscale funnel` は使いません。

## 2. ディレクトリと担当

| パス | 内容 | 担当 |
|---|---|---|
| `packages/shared/` | 共通の型（[protocol.ts](../packages/shared/src/protocol.ts)） | **共同**（変更は合意制） |
| `packages/hub/` | サーバー本体（セッション管理、保存、配信、Push、認証） | Claude |
| `packages/web/` | PWA（React + Vite） | Claude |
| `packages/web/src/agents/codex/` | Codex 固有の表示部品（差分ビューなど、必要な場合のみ） | Codex |
| `packages/driver-claude/` | Claude CLI ヘッドレスの Driver | Claude |
| `packages/driver-codex/` | Codex app-server の Driver | Codex |
| `docs/` | 設計文書 | 共同（自分の担当部分を書く） |

運用のルール:
- 自分の担当外のファイルは変更しない。必要な変更は、相手への依頼として PR の説明か Issue に書く。
- `packages/shared/` の変更だけを含む PR を、先に単独で出す（ブランチ名は `protocol/*`）。マージするかはユーザーが判断する。
- ブランチ名は担当ごとに `claude/*`、`codex/*` とする。
- 各担当は相手の作業を待たなくてよい。Driver はフィクスチャ（JSONL）と `scripts/try.ts` で単体で開発し、Web はフィクスチャを流し込んで表示を作る。

## 3. 技術スタック

- Node.js（現行 LTS）+ TypeScript、npm workspaces、ESM
- Hub: Fastify + WebSocket、SQLite（better-sqlite3）、Web Push（VAPID）
- Web: React + Vite + vite-plugin-pwa、ダークテーマ固定
- 常駐化: 最初は手動起動。後で Windows のタスクスケジューラかサービスに登録する

## 4. 表示の優先順位

1. 許可／承認待ち（`waiting_approval`）
2. 質問待ち（`waiting_input`）
3. 完了・未読（`idle` かつ未読。既読管理は Hub）
4. 実行中（`running` / `starting`）
5. アイドル・停止（`idle` で既読、`error`、`stopped`）

同じ順位の中では、待ちが長い順に並べます。状態が 1〜3 に変わったら Web Push で通知し、アプリアイコンにバッジを付けます。

## 5. 画面構成

- **iPhone**: 下部タブで Claude / Codex / 設定 を切り替えます。一覧から詳細へは、1画面ずつ遷移します。
- **iPad / Web**: ペインを何枚でも並べられます。
  - レイアウトは「1列・2列・3列・2×2」から選べ、Web ではさらに境界をドラッグして自由に分割できます。
  - iPad で画面に収まらないペインは、横スワイプで表示します。
  - 「次の待ちへ」（Web は Alt+J）で、待っているペインに順番にフォーカスが移ります。
  - 左の一覧から、セッションをペインへドラッグして配置します。
- **権限モードの切り替え**（全端末共通）: ペインの入力欄の左に、現在のモード（「毎回確認」「編集は自動」「すべて自動」「計画のみ」）を出すボタンを置きます。押すとメニューが開き、実行中・許可待ちのどの状態でも切り替えられます。Web では Shift+Tab でも順に切り替えます。
  - 「すべて自動」は、許可したフォルダのセッションでだけ選べます（他のフォルダでは無効表示）。選ぶときは確認を1回挟みます。
  - 「すべて自動」のセッションは、一覧の行とペインのヘッダーに「⚠ 自動」と黄色（`#d29922`）の文字で示します。
  - 新規セッションの開始画面でも、モードを選べます。

## 6. セキュリティ

- Hub は `127.0.0.1` でのみ待ち受け、`tailscale serve` が中継します。
- serve が付ける `Tailscale-User-Login` ヘッダーを確認し、許可したユーザー以外は拒否します。
- Tailscale の ACL で、Hub のポートに届く端末を自分の端末に限定します。
- 起動できるフォルダは、マシンごとの許可リストに限ります。
- 権限モードの既定は「毎回確認」です。
- 「すべて自動」（`full_auto`）は、フォルダの許可リストで個別に許可したフォルダだけで使えます。Hub がこの制限を守り、許可のないセッションへの切り替えは拒否します。

## 7. フェーズ

1. **MVP**: このPCのみ。Claude と Codex それぞれで、複数セッション・優先表示・許可操作ができる。iPhone 表示と、iPad/Web の複数ペイン表示。ペインの並びは端末ごとに自動保存し、次に開いたときに復元する。
2. Web Push、再起動後の再開、差分表示
3. 他マシンの Runner、フォルダの許可リスト管理画面
4. 常駐化

## 8. 見送った機能

- **ワークスペース**（ペインの並びと各ペインのセッションに名前を付けて保存し、切り替える機能）は MVP に入れない。必要になったら追加する。

## 9. デザインの決まり

- 配色は GitHub の Primer（`@primer/primitives` 11.10.0）の dark テーマのトークン値を使う。

| 用途 | 値 |
|---|---|
| 背景（本文） | `#0d1117`（bgColor-default） |
| 背景（ヘッダー・サイドバー・ユーザー発言） | `#151b23`（bgColor-muted） |
| 背景（入力欄・コード） | `#010409`（bgColor-inset） |
| 通常ボタン | 背景 `#212830`、枠 `#3d444d` |
| 主ボタン（許可・送信・開始） | 背景 `#238636`、文字 `#ffffff` |
| 境界線 | `#3d444d` |
| 文字 | `#f0f6fc`、補助 `#9198a1` |
| 許可／承認待ち | `#d29922`、強調面 `#bb800926`、枠 `#9e6a03` |
| 質問 | `#ab7df8` |
| 完了・未読 | `#4493f8` |
| 実行中 | `#3fb950` |
| エラー・削除行 | `#f85149` |
| Claude の識別色 | `#db6d28` |
| Codex の識別色 | `#4493f8` |

- 形はシンプルにする。角丸は、ボタン・入力欄・コード枠など操作部品だけに 6px（件数バッジは 3px）を使い、一覧・ペイン・パネルは角丸なしにする。
- 影、グラデーション、丸いピル型のラベルは使わない。状態は「● 許可待ち」のように、色付きの点と文字で表す。
- 一覧はカードを並べず、区切り線のある行で表示する（VS Code のサイドバーに近い密度）。
- 待っているペインは、ヘッダー上端に 2px の黄色の線を引いて示す（VS Code のアクティブタブと同じ表現）。
