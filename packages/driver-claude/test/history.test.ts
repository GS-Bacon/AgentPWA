// 巻き戻しとフォーク（v11）: resume_token の形、会話の記録（jsonl）からの位置の求め方、ClaudeSession の rewind。
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '@agentpwa/shared';
import { forkPoint, formatResumeToken, parseResumeToken, parseTranscript, resumeArgs, rewindPoint } from '../src/history.ts';
import type { LaunchSpec, ProcessLauncher } from '../src/launcher.ts';
import { ClaudeSession } from '../src/session.ts';
import { createClaudeDriver } from '../src/index.ts';

/** 実際の記録（Claude Code 2.1.327）を縮めたもの: u1 → ツール → 答え → system → u2 → 答え */
const LINES = [
  { type: 'queue-operation' },
  { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'one' } },
  { type: 'attachment', uuid: 'x1', parentUuid: 'u1' },
  { type: 'assistant', uuid: 'a1', parentUuid: 'x1', message: { content: [{ type: 'tool_use' }] } },
  { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { content: [{ type: 'tool_result' }] } },
  { type: 'user', uuid: 'm1', parentUuid: 'r1', isMeta: true, message: { content: 'meta' } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'm1', message: { content: [{ type: 'text' }] } },
  { type: 'system', uuid: 's1', parentUuid: 'a2' },
  { type: 'user', uuid: 'u2', parentUuid: 's1', message: { content: [{ type: 'text', text: 'two' }] } },
  { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { content: [{ type: 'text' }] } },
];
const JSONL = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n{"broken';

describe('resume_token', () => {
  it('途中から始める予定を入れて読み戻せる', () => {
    for (const ref of [{ sessionId: 'abc-1' }, { sessionId: 'abc-1', at: 'u-2', fork: true }, { sessionId: '' }]) {
      expect(parseResumeToken(formatResumeToken(ref))).toEqual(ref);
    }
    expect(parseResumeToken('../etc')).toBeNull();
    expect(parseResumeToken('abc|at=../x')).toBeNull();
    expect(parseResumeToken(undefined)).toBeNull();
  });

  it('CLI の引数にする', () => {
    expect(resumeArgs(parseResumeToken('abc'))).toEqual(['--resume', 'abc']);
    expect(resumeArgs(parseResumeToken('abc|at=s1|fork'))).toEqual(['--resume', 'abc', '--resume-session-at', 's1', '--fork-session']);
    expect(resumeArgs(parseResumeToken('fresh'))).toEqual([]);
  });
});

describe('会話の記録', () => {
  const entries = parseTranscript(JSONL);

  it('巻き戻しの位置は発言の直前の記録。最初の発言なら null', () => {
    expect(rewindPoint(entries, 'u2')).toBe('s1');
    expect(rewindPoint(entries, 'u1')).toBeNull();
    // ツールの結果や CLI が足した文は、ユーザーの発言として扱わない
    expect(() => rewindPoint(entries, 'r1')).toThrow('見つかりません');
    expect(() => rewindPoint(entries, 'm1')).toThrow('見つかりません');
  });

  it('フォークの位置は次のユーザーの発言の直前。最後の発言なら undefined', () => {
    expect(forkPoint(entries, 'u1')).toBe('s1');
    expect(forkPoint(entries, 'u2')).toBeUndefined();
    expect(() => forkPoint(entries, 'zz')).toThrow('見つかりません');
  });
});

class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor() {
    super();
    this.stdin.on('finish', () => this.emit('exit', 0));
  }
  kill(): void {
    this.emit('exit', null);
  }
}

function setup(opts: { runCode?: number } = {}) {
  const specs: LaunchSpec[] = [];
  const runs: LaunchSpec[] = [];
  const reads: string[] = [];
  const launcher: ProcessLauncher = {
    os: 'linux',
    homeDir: async () => '/home/me',
    spawn(spec) {
      specs.push(spec);
      return new FakeCli() as unknown as ChildProcessWithoutNullStreams;
    },
    run: async (spec) => {
      runs.push(spec);
      return { code: opts.runCode ?? 0, stdout: '', stderr: opts.runCode ? 'no checkpoint' : '' };
    },
    remove: async () => {},
    readText: async (p) => {
      reads.push(p);
      return JSONL;
    },
  };
  const events: DriverEvent[] = [];
  const session = new ClaudeSession(
    { sessionId: 's1', cwd: '/w/app', permissionMode: 'ask', resumeToken: 'abc' },
    (e) => events.push(e),
    { launcher, claudePath: 'claude', env: {}, rewind: true },
  );
  return { session, events, specs, runs, reads };
}

describe('ClaudeSession の巻き戻し', () => {
  it('送った発言に uuid を付けて rewindable にし、ファイルの控えを取らせる', async () => {
    const { session, events, specs } = setup();
    await session.init();
    await session.send({ type: 'send', text: 'hi' });
    expect(events.find((e) => e.type === 'message')).toMatchObject({ role: 'user', rewindable: true });
    expect(specs[0].env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('true');
  });

  it('会話とコードを戻す: ファイルを --rewind-files で戻し、次の起動を発言の直前からのフォークにする', async () => {
    const { session, events, specs, runs, reads } = setup();
    await session.init();
    await session.send({ type: 'rewind', messageId: 'u2', restore: 'both' });
    expect(reads[0].replace(/\\/g, '/')).toBe('/home/me/.claude/projects/-w-app/abc.jsonl');
    expect(runs[0].args).toEqual(['-p', '--resume', 'abc', '--rewind-files', 'u2']);
    expect(events).toContainEqual({ type: 'resume_token', token: 'abc|at=s1|fork' });
    expect(events.at(-1)).toEqual({ type: 'rewound', messageId: 'u2' });
    await session.send({ type: 'send', text: 'やり直し' });
    const args = specs[0].args;
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5)).toEqual(['--resume', 'abc', '--resume-session-at', 's1', '--fork-session']);
  });

  it('最初の発言まで会話を戻すと、何も引き継がずに新しく始める', async () => {
    const { session, events, specs, runs } = setup();
    await session.init();
    await session.send({ type: 'rewind', messageId: 'u1', restore: 'conversation' });
    expect(runs).toHaveLength(0);
    expect(events).toContainEqual({ type: 'resume_token', token: 'fresh' });
    await session.send({ type: 'send', text: '最初から' });
    expect(specs[0].args).not.toContain('--resume');
  });

  it('ファイルを戻せなければ、会話も戻さずに失敗する', async () => {
    const { session, events } = setup({ runCode: 1 });
    await session.init();
    await expect(session.send({ type: 'rewind', messageId: 'u2', restore: 'both' })).rejects.toThrow('no checkpoint');
    expect(events.some((e) => e.type === 'rewound' || e.type === 'resume_token')).toBe(false);
  });

  it('作業中は巻き戻せない', async () => {
    const { session } = setup();
    await session.init();
    await session.send({ type: 'send', text: 'x' });
    await expect(session.send({ type: 'rewind', messageId: 'u2', restore: 'conversation' })).rejects.toThrow('作業中');
  });
});

describe('Driver のフォーク', () => {
  it('発言のターンの終わりからのフォークを resume_token にし、起動前のフォークの記録は消さない', async () => {
    const removed: string[][] = [];
    const launcher: ProcessLauncher = {
      os: 'linux',
      homeDir: async () => '/home/me',
      spawn: () => new FakeCli() as unknown as ChildProcessWithoutNullStreams,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      remove: async (p) => void removed.push(p),
      readText: async () => JSONL,
    };
    const d = createClaudeDriver({ launcher });
    expect(d.supportsRewind).toBe(true);
    expect(await d.forkToken!({ cwd: '/w', resumeToken: 'abc', messageId: 'u1' })).toBe('abc|at=s1|fork');
    expect(await d.forkToken!({ cwd: '/w', resumeToken: 'abc', messageId: 'u2' })).toBe('abc|fork');
    await d.deleteHistory!({ cwd: '/w', resumeToken: 'abc|at=s1|fork' });
    expect(removed).toHaveLength(0);
    await d.deleteHistory!({ cwd: '/w', resumeToken: 'abc' });
    expect(removed).toHaveLength(1);
  });
});
