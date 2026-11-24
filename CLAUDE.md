# CLAUDE.md — Claude Code 向け作業ガイド

このリポジトリは、Claude（Claude Code）と Codex で分担して開発します。全体構成と担当表は [docs/architecture.md](docs/architecture.md)、Hub と Driver の契約は [docs/protocol.md](docs/protocol.md) と [packages/shared/src/protocol.ts](packages/shared/src/protocol.ts) にあります。

## 担当範囲

変更してよい場所:
- `packages/hub/**`、`packages/web/**`（`packages/web/src/agents/codex/**` を除く）、`packages/driver-claude/**`
- [docs/architecture.md](docs/architecture.md)、[docs/protocol.md](docs/protocol.md) の「Claude」の対応表

変更しない場所（Codex の担当）:
- `packages/driver-codex/**`、`packages/web/src/agents/codex/**`、`AGENTS.md`
- Codex 側に必要な変更は、依頼として PR の説明か Issue に書く。

`packages/shared/**` は共同管理です。変更は直接入れてよいですが、そのたびに docs/protocol.md の変更履歴に追記し、Codex 側の対応が要るものは docs/protocol.md の「Codex への依頼」に書きます。

## 前提（変えないこと）

- Claude は、ユーザーがログインした `claude` CLI をヘッドレス（`claude -p` + stream-json）で動かす。Claude Agent SDK と API キーは使わない（従量課金になるため）。
- 公開は `tailscale serve` だけで行う。Hub は `127.0.0.1` でのみ待ち受ける。
- UI はダークテーマのみで、配色は GitHub Primer の dark テーマに合わせる。角丸は操作部品の 6px だけにし、影・グラデーション・ピル型ラベルは使わない（詳細は docs/architecture.md の「デザインの決まり」）。
- セッションはプロジェクト（作業フォルダ）ごとにまとめる（Claude のプロジェクトに近い形）。使う AI（Claude / Codex）はプロジェクトごとに固定し（設定ファイルの folders の agent）、プロジェクト名の横のアイコンで示す。プロジェクトはフォルダと AI の組で、同じフォルダを AI ごとに1つずつ別のプロジェクトとして登録できる。返答待ちのセッションを常に先頭に出す。iPad と Web では、ペインを何枚でも並べられる。
- ワークスペース（ペインの並びに名前を付けて保存する機能）は MVP では作らない。ペインの並びは端末ごとに自動で復元する。

## 共通ルール

- 文書とコメントは日本語で書く。
- ユーザーへの返答（途中経過・最後のまとめを含む）は日本語で書く。
- Node.js（現行 LTS）+ TypeScript、ESM。パッケージ管理は npm workspaces。
- コミットとプッシュはユーザーに頼まれたときだけ行う。ブランチ名の決まりはない。
- API キー、トークン、`.env` はコミットしない。
