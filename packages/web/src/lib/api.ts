// Hub の REST API
import type { SessionEvent, UserAction } from '@agentpwa/shared';
import type { CreateSessionRequest, HubInfo, SessionSummary } from '@agentpwa/hub/api';

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
  update: (id: string, patch: { title?: string; archived?: boolean }) => req<SessionSummary>('PATCH', `/api/sessions/${id}`, patch),
};
