# AGENTS.md — Codex 向け作業ガイド

このリポジトリは、Claude（Claude Code）と Codex で分担して開発します。Codex の担当は **Codex 用の Driver** です。

まず次の2つを読んでください。
- [docs/architecture.md](docs/architecture.md) — 全体構成と担当表
- [docs/protocol.md](docs/protocol.md) と [packages/shared/src/protocol.ts](packages/shared/src/protocol.ts) — Hub との契約

## 担当範囲

変更してよい場所:
- `packages/driver-codex/**`
- `packages/web/src/agents/codex/**`（Codex 固有の表示部品が必要になった場合のみ）
- [docs/protocol.md](docs/protocol.md) の「Codex」の対応表

変更しない場所（必要なら依頼として書く）:
- `packages/shared/**` — 変更が必要なら、`protocol/*` ブランチで共有型だけを変える PR を別に出す
- `packages/hub/**`、`packages/web/**`（上の例外を除く）、`packages/driver-claude/**`
- `CLAUDE.md`

## 作るもの: `packages/driver-codex`

`codex app-server`（JSON-RPC 2.0 over stdio）を子プロセスとして起動し、`AgentDriver` インターフェースを実装します。

```ts
import type { AgentDriver } from '@agentpwa/shared';
export function createCodexDriver(options?: { codexPath?: string }): AgentDriver;
```

要件:
1. **ChatGPT プランのログインで動かす**: `OPENAI_API_KEY` などで API キー課金になる状態なら、`checkAuth()` で `auth: 'api_key'` を返す。ログインしていなければ `auth: 'none'` を返す。
2. **対応付け**（詳細は docs/protocol.md の表を埋めながら確定する）
   - 開始: `thread/start` → `turn/start`
   - 再開: `thread/resume`。`thread.id` を `resume_token` イベントで返す
   - 中断: `turn/interrupt`
   - 実行中の追加指示: `turn/steer`
   - コマンド実行やファイル変更の承認リクエストは `approval_request` に変換する。`FileChange` には差分の行数と diff を入れる
   - ユーザー入力の要求（`tool/requestUserInput` など）は `question` に変換する
3. **状態遷移**: docs/protocol.md の「状態遷移」と「Driver が守ること」に従う。
4. **単体で試せる**: `scripts/try.ts` で、Hub なしで Driver を起動できるようにする。
5. **フィクスチャ**: `fixtures/` に、実セッションから記録した JSONL を3本以上置く（承認・質問・中断）。
6. **テスト**: app-server をモックした単体テストを置く。実際の CLI を使うテストは、手動実行用として分ける。

app-server のメソッド名や形は版によって変わる可能性があります。公式ドキュメントと、手元の `codex` の版で確認してから実装してください。確認した版は `packages/driver-codex/README.md` に書いてください。

## 共通ルール

- 文書とコメントは日本語で書く。
- Node.js（現行 LTS）+ TypeScript、ESM。パッケージ管理は npm workspaces。
- コミットとプッシュはユーザーに頼まれたときだけ行う。ブランチ名は `codex/*`。
- API キー、トークン、`.env` はコミットしない。
