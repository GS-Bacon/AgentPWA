// AI がセッションの中から、Hub の API で新しいセッションを作れるようにする。
// Hub は自分の URL を環境変数 AGENTPWA_HUB_URL に入れて起動する。Driver は子プロセスに
// AGENTPWA_SESSION_ID（Hub のセッション ID）を渡し、作り方を --append-system-prompt で伝える。
// Hub は X-AgentPWA-Session を見て作成元のセッションを記録し、Web はそれを見て新しいセッションを自動で開く。

/** 子プロセスの環境変数に、作成元として使うセッション ID を足す（Hub の URL が無ければ何もしない） */
export function withHubEnv(env: NodeJS.ProcessEnv, sessionId: string): NodeJS.ProcessEnv {
  if (!env.AGENTPWA_HUB_URL) return env;
  return { ...env, AGENTPWA_SESSION_ID: sessionId };
}

/** --append-system-prompt に渡す説明（Hub の URL が無ければ undefined） */
export function hubGuide(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.AGENTPWA_HUB_URL) return undefined;
  return [
    '# AgentPWA',
    'このセッションは AgentPWA（スマホやブラウザから AI のセッションを操作するアプリ）の Hub から動いています。',
    'ユーザーに頼まれたときや、独立した作業を別のセッションに任せたいときは、Hub の API で新しいセッションを作れます。作ったセッションは、ユーザーの画面で自動的に開きます。',
    '',
    '```bash',
    'curl -sS -X POST "$AGENTPWA_HUB_URL/api/sessions" \\',
    '  -H "Content-Type: application/json" -H "X-AgentPWA-Session: $AGENTPWA_SESSION_ID" \\',
    "  --data-binary @- <<'JSON'",
    '{"prompt": "新しいセッションへの最初の指示", "title": "セッション名（省略可）"}',
    'JSON',
    '```',
    '',
    '- prompt は必ず入れてください（何も書き込まれていないセッションは、ユーザーが閉じると消えます）。新しいセッションはこの会話を知らないので、必要な前提を prompt に書きます。',
    '- cwd を省くと、このセッションと同じプロジェクト（作業フォルダ）で始まります。別のプロジェクトにするときは "cwd" に登録済みのプロジェクトのフォルダの絶対パスを入れます。',
    '- 同じフォルダが Claude と Codex の両方のプロジェクトとして登録されているときは、"agent"（"claude" / "codex"）でどちらで始めるかを選べます（省略はこのセッションと同じ AI）。',
    '- model・effort・permissionMode も指定できます（省略はプロジェクトの既定）。',
    '- 応答は新しいセッションの情報（JSON。id を含む）です。新しいセッションの結果は、この会話には戻ってきません。',
    '',
    '## 入力欄の # の候補',
    'ユーザーが入力欄で # を打つと、プロジェクトごとに登録した候補（例: 案件の記号 J01）が出て、選ぶと「#J01」が入ります。',
    'ユーザーに頼まれたら、このプロジェクトの候補を Hub の API で書き換えられます（tags は全体を置き換えます。空の配列で外します）。',
    'いまの候補は `GET $AGENTPWA_HUB_URL/api/info` の folders の tags にあります。',
    '',
    '```bash',
    'curl -sS -X PATCH "$AGENTPWA_HUB_URL/api/projects" \\',
    '  -H "Content-Type: application/json" -H "X-AgentPWA-Session: $AGENTPWA_SESSION_ID" \\',
    "  --data-binary @- <<'JSON'",
    '{"path": "このセッションの作業フォルダの絶対パス", "agent": "claude", "tags": [{"name": "J01", "description": "説明（省略可）"}]}',
    'JSON',
    '```',
    '',
    '- name は空白と # を含まない 64 文字までで、500 件まで登録できます。候補はこの順のまま出ます。',
  ].join('\n');
}
