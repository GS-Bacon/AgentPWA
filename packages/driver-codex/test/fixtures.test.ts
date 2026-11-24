import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '@agentpwa/shared';

describe('実セッション由来のフィクスチャ', () => {
  for (const name of ['approval', 'question', 'interrupt']) {
    it(`${name} の記録は待機を解決して終了し、ストリームを確定する`, () => {
      const raw = readFileSync(new URL(`../fixtures/${name}.jsonl`, import.meta.url), 'utf8');
      const events = raw.trim().split('\n').map((s) => JSON.parse(s) as DriverEvent);
      expect(raw).not.toMatch(/C:\\\\Users|sk-[A-Za-z0-9]|access_token|refresh_token/);
      expect(events[0]).toEqual({ type: 'status', status: 'starting' });
      expect(events.at(-1)).toEqual({ type: 'status', status: 'stopped' });
      const pending = new Set<string>();
      const messages = new Set<string>();
      events.forEach((event, i) => {
        if (event.type === 'approval_request' || event.type === 'question') {
          pending.add(event.requestId);
          expect(events[i + 1]).toEqual({ type: 'status', status: event.type === 'question' ? 'waiting_input' : 'waiting_approval' });
        }
        if (event.type === 'approval_resolved' || event.type === 'question_resolved') pending.delete(event.requestId);
        if (event.type === 'message_delta') messages.add(event.messageId);
        if (event.type === 'message') messages.delete(event.messageId);
      });
      expect(pending.size).toBe(0); expect(messages.size).toBe(0);
      if (name === 'approval') expect(events).toContainEqual(expect.objectContaining({ type: 'approval_request', changes: [expect.objectContaining({ additions: 1, deletions: 0, diff: expect.stringContaining('+テスト') })] }));
      if (name === 'question') expect(events).toContainEqual(expect.objectContaining({ type: 'question', questions: [expect.objectContaining({ options: expect.arrayContaining([{ label: '青', description: '青を選択します。' }]) })] }));
      if (name === 'interrupt') expect(events).toContainEqual({ type: 'status', status: 'idle', reason: '中断しました' });
    });
  }
});
