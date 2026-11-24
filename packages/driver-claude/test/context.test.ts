// assistant メッセージの usage と result の modelUsage から、context イベント（コンテキストの使用量）を作れるか確かめる。
// 入力は Claude Code 2.1 の実際の出力を短くしたもの。
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '@agentpwa/shared';
import { StreamMapper } from '../src/mapper.ts';

const ctx = (evs: DriverEvent[]) => evs.filter((e) => e.type === 'context');

const assistant = (id: string, usage: object, model = 'claude-opus-5-5', parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, model, content: [{ type: 'text', text: '2' }], usage },
});

const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  modelUsage: { 'claude-opus-5-5': { inputTokens: 2, contextWindow: 1000000 }, 'claude-haiku-5-5': { contextWindow: 200000 } },
};

describe('コンテキストの使用量', () => {
  it('入力・キャッシュ・出力の合計を送り、result で上限を付ける', () => {
    const m = new StreamMapper();
    const a = ctx(m.map(assistant('msg_1', { input_tokens: 2, cache_creation_input_tokens: 9387, cache_read_input_tokens: 17685, output_tokens: 3 })).events);
    expect(a).toEqual([{ type: 'context', usedTokens: 27077 }]);
    expect(ctx(m.map(result).events)).toEqual([{ type: 'context', usedTokens: 27077, windowTokens: 1000000 }]);
    // 同じ値は送り直さない
    expect(ctx(m.map(result).events)).toEqual([]);
    // 上限が分かった後は、assistant の時点で上限も付ける
    expect(ctx(m.map(assistant('msg_2', { input_tokens: 5, cache_read_input_tokens: 30000, output_tokens: 10 })).events)).toEqual([
      { type: 'context', usedTokens: 30015, windowTokens: 1000000 },
    ]);
  });

  it('サブエージェントと <synthetic> のメッセージは数えない', () => {
    const m = new StreamMapper();
    expect(ctx(m.map(assistant('msg_s', { input_tokens: 500 }, 'claude-opus-5-5', 'toolu_x')).events)).toEqual([]);
    expect(ctx(m.map(assistant('msg_y', { input_tokens: 0, output_tokens: 0 }, '<synthetic>')).events)).toEqual([]);
  });
});
