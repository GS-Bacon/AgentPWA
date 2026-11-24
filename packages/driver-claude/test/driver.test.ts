import { describe, expect, it } from 'vitest';
import { detectApiKeyEnv, mapAuthMethod } from '../src/auth.ts';
import { StreamMapper } from '../src/mapper.ts';
import { answerToUpdatedInput, buildPrompt, fromClaudePermissionMode, sessionAllowKey, summarizeTool, toClaudePermissionMode } from '../src/permissions.ts';
import { projectDirName } from '../src/index.ts';

describe('auth', () => {
  it('authMethod をプロトコルの auth に対応付ける', () => {
    expect(mapAuthMethod('claude.ai', true)).toBe('subscription');
    expect(mapAuthMethod('oauth_token', true)).toBe('subscription');
    expect(mapAuthMethod('api_key', true)).toBe('api_key');
    expect(mapAuthMethod('api_key_helper', true)).toBe('api_key');
    expect(mapAuthMethod('third_party', true)).toBe('api_key');
    expect(mapAuthMethod('none', false)).toBe('none');
    expect(mapAuthMethod(undefined, false)).toBe('none');
    expect(mapAuthMethod('something', true)).toBe('unknown');
  });

  it('API キーの環境変数を検出する', () => {
    expect(detectApiKeyEnv({ ANTHROPIC_API_KEY: 'sk-xxx' })).toBe('ANTHROPIC_API_KEY');
    expect(detectApiKeyEnv({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('CLAUDE_CODE_USE_BEDROCK');
    expect(detectApiKeyEnv({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBeUndefined();
    expect(detectApiKeyEnv({ ANTHROPIC_BASE_URL: 'http://x' })).toBeUndefined();
  });
});

describe('permissions', () => {
  it('権限モードを claude の値に対応付ける', () => {
    expect(toClaudePermissionMode('ask')).toBe('default');
    expect(toClaudePermissionMode('auto_edit')).toBe('acceptEdits');
    expect(toClaudePermissionMode('auto')).toBe('auto');
    expect(toClaudePermissionMode('full_auto')).toBe('bypassPermissions');
    expect(toClaudePermissionMode('plan')).toBe('plan');
  });

  it('claude の権限モードをプロトコルの値に戻す', () => {
    for (const m of ['ask', 'auto_edit', 'auto', 'full_auto', 'plan'] as const) {
      expect(fromClaudePermissionMode(toClaudePermissionMode(m))).toBe(m);
    }
    expect(fromClaudePermissionMode('dontAsk')).toBeUndefined();
  });

  it('履歴フォルダ名は英数字以外を - にする', () => {
    expect(projectDirName(String.raw`C:\Users\me\work`)).toBe('C--Users-me-work');
    expect(projectDirName('/home/me/my_app')).toBe('-home-me-my-app');
  });

  it('Bash は command の承認要求になる', () => {
    const p = buildPrompt('r1', 'Bash', { command: 'npm create vite@latest web' }, 'C:\\work');
    expect(p.kind).toBe('approval');
    expect(p.event).toMatchObject({ type: 'approval_request', requestId: 'r1', kind: 'command', command: 'npm create vite@latest web', cwd: 'C:\\work' });
  });

  it('Edit は差分付きの file_change になる', () => {
    const p = buildPrompt('r2', 'Edit', { file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'c' }, '/w');
    expect(p.event).toMatchObject({ kind: 'file_change', changes: [{ path: 'src/a.ts', kind: 'modify', additions: 1, deletions: 2 }] });
  });

  it('AskUserQuestion は question になり、回答は answers に入る', () => {
    const input = { questions: [{ question: 'ポートは？', header: 'Port', options: [{ label: '443' }, { label: '8443' }], multiSelect: false }] };
    const p = buildPrompt('r3', 'AskUserQuestion', input, '/w');
    expect(p).toEqual({ kind: 'question', event: { type: 'question', requestId: 'r3', prompt: 'ポートは？', options: ['443', '8443'] } });
    expect(answerToUpdatedInput(input, '443')).toMatchObject({ answers: { 'ポートは？': '443' } });
  });

  it('セッション中の許可はシェルの先頭語ごとに覚える', () => {
    expect(sessionAllowKey('Bash', { command: 'npm test -- api' })).toBe('Bash:npm');
    expect(sessionAllowKey('Edit', { file_path: 'x' })).toBe('Edit');
  });

  it('ツールの一行要約', () => {
    expect(summarizeTool('Edit', { file_path: 'src/api.ts', old_string: 'a\nb\nc\nd', new_string: '1\n2\n3\n4\n5\n6' })).toBe('src/api.ts +6 −4');
    expect(summarizeTool('Bash', { command: 'npm test\necho done' })).toBe('npm test');
  });
});

describe('StreamMapper', () => {
  it('init から resume_token を出す', () => {
    const m = new StreamMapper();
    const r = m.map({ type: 'system', subtype: 'init', session_id: 'abc', apiKeySource: 'none' });
    expect(r.events).toEqual([{ type: 'resume_token', token: 'abc' }]);
    expect(r.init).toMatchObject({ sessionId: 'abc', apiKeySource: 'none' });
  });

  it('system/init と system/status の permissionMode を返す', () => {
    const m = new StreamMapper();
    expect(m.map({ type: 'system', subtype: 'init', session_id: 'abc', permissionMode: 'acceptEdits' }).permissionMode).toBe('auto_edit');
    expect(m.map({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' }).permissionMode).toBe('ask');
  });

  it('ストリーミング断片と完成版のメッセージが同じ messageId になる', () => {
    const m = new StreamMapper();
    m.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } });
    m.map({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
    m.map({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    const d = m.map({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'こん' } } });
    expect(d.events).toEqual([{ type: 'message_delta', messageId: 'msg_1:1', text: 'こん' }]);
    const a = m.map({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'こんにちは' }] } });
    expect(a.events).toEqual([{ type: 'message', messageId: 'msg_1:1', role: 'assistant', text: 'こんにちは' }]);
  });

  it('tool_use と tool_result を tool イベントにする', () => {
    const m = new StreamMapper();
    const a = m.map({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } });
    expect(a.events).toEqual([{ type: 'tool', toolId: 'toolu_1', name: 'Bash', summary: 'npm test', state: 'running' }]);
    const u = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] } });
    expect(u.events).toEqual([{ type: 'tool', toolId: 'toolu_1', name: 'Bash', summary: 'npm test', state: 'done', output: 'ok' }]);
  });

  it('ファイルを対象にするツールは paths に対象ファイルを入れる', () => {
    const m = new StreamMapper();
    const input = { file_path: 'C:\\work\\slides\\index.html', content: '<html>\n</html>' };
    const a = m.map({ type: 'assistant', message: { id: 'msg_3', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input }] } });
    expect(a.events).toEqual([{ type: 'tool', toolId: 'toolu_2', name: 'Write', summary: 'C:\\work\\slides\\index.html +2', paths: ['C:\\work\\slides\\index.html'], state: 'running' }]);
    const u = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok', is_error: false }] } });
    expect(u.events[0]).toMatchObject({ paths: ['C:\\work\\slides\\index.html'], state: 'done' });
  });

  it('result でターン終了を知らせる', () => {
    const m = new StreamMapper();
    expect(m.map({ type: 'result', subtype: 'success', is_error: false, result: 'done' }).turnEnded).toEqual({ isError: false, errors: [] });
    expect(m.map({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'] }).turnEnded).toEqual({ isError: true, errors: ['too many'] });
  });

  it('rate_limit_event を usage にする', () => {
    const m = new StreamMapper();
    const r = m.map({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.16, resetsAt: 1795497600 }, seven_day: { utilization: 0.04, resetsAt: 1795932000 } } } });
    expect(r.events).toEqual([
      { type: 'usage', label: 'セッション枠（5時間）', percent: 16, resetsAt: new Date(1795497600 * 1000).toISOString() },
      { type: 'usage', label: '週間', percent: 4, resetsAt: new Date(1795932000 * 1000).toISOString() },
    ]);
  });
});
