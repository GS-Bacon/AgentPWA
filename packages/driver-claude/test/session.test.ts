// ClaudeSession の制御メッセージ（stdio）のやりとりを、偽の起動役と偽の CLI で確かめる。
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DriverEvent, PermissionMode } from '@agentpwa/shared';
import type { LaunchSpec, ProcessLauncher } from '../src/launcher.ts';
import { ClaudeSession } from '../src/session.ts';
import { createClaudeDriver } from '../src/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 標準入出力だけを持つ偽の CLI。CLI が書いた行（stdin）を記録し、CLI からの出力（stdout）を流せる。 */
class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: any[] = [];
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.written.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    this.stdin.on('finish', () => this.emit('exit', 0));
  }
  out(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }
  kill(): void {
    this.emit('exit', null);
  }
}

function setup(mode: PermissionMode = 'ask') {
  const clis: FakeCli[] = [];
  const specs: LaunchSpec[] = [];
  const launcher: ProcessLauncher = {
    os: 'linux',
    homeDir: async () => '/home/me',
    spawn(spec) {
      specs.push(spec);
      const c = new FakeCli();
      clis.push(c);
      return c as unknown as ChildProcessWithoutNullStreams;
    },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    remove: async () => {},
  };
  const events: DriverEvent[] = [];
  const session = new ClaudeSession({ sessionId: 's1', cwd: '/w', permissionMode: mode }, (e) => events.push(e), { launcher, claudePath: 'claude', env: {} });
  return { session, events, clis, specs };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('ClaudeSession（stdio の制御メッセージ）', () => {
  it('起動時に権限モードを知らせ、stdio の許可ツールで CLI を起動する', async () => {
    const { session, events, specs } = setup('auto');
    await session.init();
    expect(events[0]).toEqual({ type: 'permission_mode', mode: 'auto' });
    await session.send({ type: 'send', text: 'hi' });
    const args = specs[0].args;
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'auto']);
    expect(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2)).toEqual(['--permission-prompt-tool', 'stdio']);
    expect(args).toContain('--allow-dangerously-skip-permissions');
    expect(args).not.toContain('--mcp-config');
  });

  it('can_use_tool を approval_request にし、許可を control_response で返す', async () => {
    const { session, events, clis } = setup();
    await session.init();
    await session.send({ type: 'send', text: 'a.txt を作って' });
    const cli = clis[0];
    cli.out({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/w/a.txt', content: 'hi' }, tool_use_id: 'toolu_1' } });
    await tick();
    const i = events.findIndex((e) => e.type === 'approval_request');
    expect(events[i]).toMatchObject({ type: 'approval_request', requestId: 'toolu_1', kind: 'file_change' });
    expect(events[i + 1]).toEqual({ type: 'status', status: 'waiting_approval' });

    await session.send({ type: 'approve', requestId: 'toolu_1', decision: 'allow' });
    await tick();
    expect(cli.written.at(-1)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'cli-1', response: { behavior: 'allow', updatedInput: { file_path: '/w/a.txt', content: 'hi' } } },
    });
    expect(events.slice(-2)).toEqual([
      { type: 'approval_resolved', requestId: 'toolu_1', decision: 'allow' },
      { type: 'status', status: 'running' },
    ]);
  });

  it('control_cancel_request で取り下げられた許可要求を解決済みにする', async () => {
    const { session, events, clis } = setup();
    await session.init();
    await session.send({ type: 'send', text: 'x' });
    clis[0].out({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_2' } });
    await tick();
    clis[0].out({ type: 'control_cancel_request', request_id: 'cli-2' });
    await tick();
    expect(events.slice(-2)).toEqual([
      { type: 'approval_resolved', requestId: 'toolu_2', decision: 'deny' },
      { type: 'status', status: 'running' },
    ]);
  });

  it('実行中の set_permission_mode は control_request で送り、成功したら permission_mode を出す', async () => {
    const { session, events, clis } = setup();
    await session.init();
    await session.send({ type: 'send', text: 'x' });
    const cli = clis[0];
    const p = session.send({ type: 'set_permission_mode', mode: 'full_auto' });
    await tick();
    const req = cli.written.at(-1);
    expect(req).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' } });
    cli.out({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { mode: 'bypassPermissions' } } });
    // CLI 自身も system/status で知らせてくるが、重ねて出さない
    cli.out({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypassPermissions' });
    await p;
    await tick();
    expect(events.filter((e) => e.type === 'permission_mode')).toEqual([
      { type: 'permission_mode', mode: 'ask' },
      { type: 'permission_mode', mode: 'full_auto' },
    ]);
  });

  it('切り替えに失敗したら error を出し、permission_mode は出さない', async () => {
    const { session, events, clis } = setup();
    await session.init();
    await session.send({ type: 'send', text: 'x' });
    const cli = clis[0];
    const p = session.send({ type: 'set_permission_mode', mode: 'auto' });
    await tick();
    const req = cli.written.at(-1);
    cli.out({ type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: 'auto mode is unavailable' } });
    await p;
    expect(events.at(-1)).toMatchObject({ type: 'error', fatal: false });
    expect(events.filter((e) => e.type === 'permission_mode')).toEqual([{ type: 'permission_mode', mode: 'ask' }]);
  });

  it('プロセスが無いときの切り替えは、次の起動の --permission-mode に使う', async () => {
    const { session, events, specs } = setup();
    await session.init();
    await session.send({ type: 'set_permission_mode', mode: 'plan' });
    expect(events.at(-1)).toEqual({ type: 'permission_mode', mode: 'plan' });
    await session.send({ type: 'send', text: 'x' });
    expect(specs[0].args[specs[0].args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('計画モードの終了など、CLI 自身による変更も permission_mode にする', async () => {
    const { session, events, clis } = setup('plan');
    await session.init();
    await session.send({ type: 'send', text: 'x' });
    clis[0].out({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await tick();
    expect(events.filter((e) => e.type === 'permission_mode').map((e) => (e as { mode: string }).mode)).toEqual(['plan', 'ask']);
  });
});

describe('deleteHistory', () => {
  it('起動役を通して、そのセッションの履歴だけを消す', async () => {
    const removed: string[][] = [];
    const launcher: ProcessLauncher = {
      os: 'linux',
      homeDir: async () => '/home/me',
      spawn: () => {
        throw new Error('not used');
      },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      remove: async (paths) => {
        removed.push(paths);
      },
    };
    const driver = createClaudeDriver({ launcher, claudePath: 'claude' });
    await driver.deleteHistory!({ cwd: '/home/me/app', resumeToken: '18d49004-96ed-451c-9a67-68cee7d977d8' });
    expect(removed).toEqual([[
      '/home/me/.claude/projects/-home-me-app/18d49004-96ed-451c-9a67-68cee7d977d8.jsonl',
      '/home/me/.claude/projects/-home-me-app/18d49004-96ed-451c-9a67-68cee7d977d8',
    ]]);
    await expect(driver.deleteHistory!({ cwd: '/home/me/app', resumeToken: '../../etc' })).rejects.toThrow();
  });
});
