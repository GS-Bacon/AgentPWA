// サブエージェント（Agent / Task ツール）の stream-json を、subagent イベントと parentToolId 付きのイベントに変換できるか確かめる。
// 入力は Claude Code の実際の出力（裏で動くサブエージェント）を短くしたもの。
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '@agentpwa/shared';
import { StreamMapper } from '../src/mapper.ts';

const PARENT = 'toolu_parent';

function run(mapper: StreamMapper, msgs: unknown[]): DriverEvent[] {
  return msgs.flatMap((m) => mapper.map(m).events);
}

const launch = {
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id: 'msg_main1',
    content: [{ type: 'tool_use', id: PARENT, name: 'Agent', input: { subagent_type: 'Explore', description: 'ファイル一覧の調査', prompt: 'Glob で調べて' } }],
  },
};

describe('サブエージェント', () => {
  it('裏で動くサブエージェントの起動から終了まで', () => {
    const mapper = new StreamMapper();
    const evs = run(mapper, [
      launch,
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: PARENT, description: 'ファイル一覧の調査', subagent_type: 'Explore', task_type: 'local_agent', prompt: 'Glob で調べて' },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: PARENT, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
        tool_use_result: { isAsync: true, status: 'async_launched' },
      },
      { type: 'assistant', parent_tool_use_id: PARENT, message: { id: 'msg_sub1', content: [{ type: 'thinking', thinking: '' }] } },
      { type: 'assistant', parent_tool_use_id: PARENT, message: { id: 'msg_sub1', content: [{ type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '**/*' } }] } },
      { type: 'system', subtype: 'task_progress', task_id: 'a1', tool_use_id: PARENT, description: 'Finding **/*', last_tool_name: 'Glob' },
      { type: 'user', parent_tool_use_id: PARENT, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_glob', content: 'a.txt\nb.txt' }] } },
      { type: 'assistant', parent_tool_use_id: PARENT, message: { id: 'msg_sub2', content: [{ type: 'text', text: 'ファイルは2つです。' }] } },
      { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed' } },
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: PARENT, status: 'completed', summary: 'ファイルは2つです。' },
    ]);

    const subs = evs.filter((e) => e.type === 'subagent');
    expect(subs[0]).toEqual({ type: 'subagent', toolId: PARENT, agentType: 'Explore', description: 'ファイル一覧の調査', prompt: 'Glob で調べて', state: 'running' });
    // 起動ツールの結果（起動しただけ）では終わらない
    expect(subs.some((e) => e.type === 'subagent' && e.progress === 'Finding **/*' && e.state === 'running')).toBe(true);
    expect(subs[subs.length - 1]).toMatchObject({ state: 'done', result: 'ファイルは2つです。' });
    expect(subs[subs.length - 1]).not.toHaveProperty('progress');

    // サブエージェント内のツールと発話には parentToolId が付く
    expect(evs).toContainEqual(expect.objectContaining({ type: 'tool', toolId: 'toolu_glob', state: 'running', parentToolId: PARENT }));
    expect(evs).toContainEqual(expect.objectContaining({ type: 'tool', toolId: 'toolu_glob', state: 'done', output: 'a.txt\nb.txt', parentToolId: PARENT }));
    expect(evs).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', text: 'ファイルは2つです。', parentToolId: PARENT }));
    // 本流のツールには付かない
    expect(evs.filter((e) => e.type === 'tool' && e.toolId === PARENT).every((e) => !('parentToolId' in e))).toBe(true);
  });

  it('前面で動いたサブエージェントは、ツールの結果で終わる', () => {
    const mapper = new StreamMapper();
    const evs = run(mapper, [
      launch,
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: PARENT, content: '調査の報告' }] } },
    ]);
    expect(evs.filter((e) => e.type === 'subagent').at(-1)).toMatchObject({ state: 'done', result: '調査の報告' });
  });

  it('プロセスが終わったら、動いているものを止まったことにする', () => {
    const mapper = new StreamMapper();
    run(mapper, [launch]);
    expect(mapper.stopSubagents()).toEqual([expect.objectContaining({ type: 'subagent', toolId: PARENT, state: 'stopped' })]);
    expect(mapper.stopSubagents()).toEqual([]);
  });

  it('サブエージェント以外のバックグラウンド作業は無視する', () => {
    const mapper = new StreamMapper();
    const evs = run(mapper, [{ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', task_type: 'local_bash', description: 'npm test' }]);
    expect(evs).toEqual([]);
  });
});
