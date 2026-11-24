// 実セッションから記録したフィクスチャが、docs/protocol.md の「状態遷移」の約束を守っているか確かめる。
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '@agentpwa/shared';

const dir = new URL('../fixtures/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

function load(f: string): DriverEvent[] {
  return fs
    .readFileSync(new URL(f, dir), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DriverEvent);
}

describe('フィクスチャ', () => {
  it('承認・質問・中断の3本がある', () => {
    expect(files).toEqual(expect.arrayContaining(['approval.jsonl', 'question.jsonl', 'interrupt.jsonl']));
  });

  for (const f of files) {
    it(`${f}: 要求の直後に待ち状態、解決の直後に running、最後は stopped`, () => {
      const evs = load(f);
      evs.forEach((e, i) => {
        if (e.type === 'approval_request') expect(evs[i + 1]).toEqual({ type: 'status', status: 'waiting_approval' });
        if (e.type === 'question') expect(evs[i + 1]).toEqual({ type: 'status', status: 'waiting_input' });
        if (e.type === 'approval_resolved' || e.type === 'question_resolved') {
          expect(evs[i + 1]).toMatchObject({ type: 'status', status: 'running' });
        }
      });
      expect(evs.some((e) => e.type === 'resume_token')).toBe(true);
      expect(evs[evs.length - 1]).toEqual({ type: 'status', status: 'stopped' });
    });
  }
});
