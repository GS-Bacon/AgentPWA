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
