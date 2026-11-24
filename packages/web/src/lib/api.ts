// Hub の REST API
import type { SessionEvent, UserAction } from '@agentpwa/shared';
import type {
  CreateProjectRequest,
  CreateSessionRequest,
  DeleteSessionResult,
  DirListing,
  FileInfo,
  FolderEntry,
  HubInfo,
  SessionSummary,
  UpdateSessionRequest,
} from '@agentpwa/hub/api';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
    } catch {
      msg = (await res.text().catch(() => '')) || msg;
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  info: () => req<HubInfo>('GET', '/api/info'),
  sessions: () => req<SessionSummary[]>('GET', '/api/sessions'),
  events: (id: string, after: number) => req<SessionEvent[]>('GET', `/api/sessions/${id}/events?after=${after}`),
  create: (body: CreateSessionRequest) => req<SessionSummary>('POST', '/api/sessions', body),
  resume: (id: string) => req<SessionSummary>('POST', `/api/sessions/${id}/resume`),
  stop: (id: string) => req<SessionSummary>('POST', `/api/sessions/${id}/stop`),
  read: (id: string, seq: number) => req<SessionSummary>('POST', `/api/sessions/${id}/read`, { seq }),
  action: (id: string, action: UserAction) => req<{ ok: true }>('POST', `/api/sessions/${id}/action`, action),
  /** 名前の変更とアーカイブ・解除（アーカイブすると Hub が動いているセッションを止める） */
  update: (id: string, patch: UpdateSessionRequest) => req<SessionSummary>('PATCH', `/api/sessions/${id}`, patch),
  /** 1件ずつ削除する（元に戻せない） */
  remove: (id: string) => req<DeleteSessionResult>('DELETE', `/api/sessions/${id}`),
  /** ルートフォルダ（projectRoots）の下のサブフォルダ。path を省くとルートの一覧 */
  dirs: (path?: string) => req<DirListing>('GET', `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  /** プロジェクトを作る（Hub が設定ファイルの folders に書き足す） */
  createProject: (body: CreateProjectRequest) => req<FolderEntry>('POST', '/api/projects', body),
  /** ファイルビュワー: プロジェクトのフォルダの下のファイルの情報（path は相対パスか絶対パス） */
  fileInfo: (id: string, path: string) => req<FileInfo>('GET', `/api/sessions/${id}/file-info?path=${encodeURIComponent(path)}`),
};
