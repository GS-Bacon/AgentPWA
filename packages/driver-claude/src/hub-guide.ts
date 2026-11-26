// AI がセッションの中から Hub の API を呼べるようにする。
// Hub は自分の URL を環境変数 AGENTPWA_HUB_URL に入れて起動し、API の使い方（このセッションの ID を含む）を
// StartOptions.hubGuide で渡す（v13。文面は packages/hub/src/hub-guide.ts）。Driver はそれを --append-system-prompt で伝え、
// 子プロセスには AGENTPWA_SESSION_ID（Hub のセッション ID）も渡す。

/** 子プロセスの環境変数に、作成元として使うセッション ID を足す（Hub の URL が無ければ何もしない） */
export function withHubEnv(env: NodeJS.ProcessEnv, sessionId: string): NodeJS.ProcessEnv {
  if (!env.AGENTPWA_HUB_URL) return env;
  return { ...env, AGENTPWA_SESSION_ID: sessionId };
}
