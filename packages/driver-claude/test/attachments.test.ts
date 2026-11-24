// 添付ファイル・スラッシュコマンド（プロトコル v7）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '@agentpwa/shared';
import { buildUserContent, createLocalAttachmentStore, safeFileName } from '../src/attachments.ts';
import { createClaudeDriver, parseCommands } from '../src/index.ts';
import type { ProcessLauncher } from '../src/launcher.ts';
import { ClaudeSession, parseLocalCommand } from '../src/session.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  written: any[] = [];
  constructor(onLine?: (msg: any, cli: FakeCli) => void) {
    super();
    let buf = '';
    this.stdin.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        this.written.push(msg);
        buf = buf.slice(i + 1);
        onLine?.(msg, this);
      }
    });
    this.stdin.on('finish', () => this.emit('exit', 0));
  }
  out(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }
  kill(): void {
    this.exitCode = 0;
    this.emit('exit', null);
  }
}

function launcherWith(onLine?: (msg: any, cli: FakeCli) => void) {
  const clis: FakeCli[] = [];
  const specs: { args: string[]; cwd?: string }[] = [];
  const launcher: ProcessLauncher = {
    os: 'linux',
    homeDir: async () => '/home/me',
    spawn(spec) {
      specs.push(spec);
      const c = new FakeCli(onLine);
      clis.push(c);
      return c as unknown as ChildProcessWithoutNullStreams;
    },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    remove: async () => {},
  };
  return { launcher, clis, specs };
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

describe('添付ファイル', () => {
  it('添付が無ければ content は文字列のまま', () => {
    expect(buildUserContent('s1', 'hi', undefined, undefined)).toEqual({ content: 'hi', infos: [] });
  });

  it('画像は画像のブロック、それ以外は保存してパスを本文に書き足す', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apwa-att-'));
    const store = createLocalAttachmentStore(root);
    const r = buildUserContent(
      's1',
      '見て',
      [
        { name: 'shot.png', mimeType: 'image/png', data: PNG },
        { name: 'log.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') },
      ],
      store,
    );
    const content = r.content as any[];
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toMatch(/^見て\n\n添付ファイル（Read ツールで読めます）:\n- /);
    const saved = /- (.+)$/.exec(content[1].text)![1];
    expect(saved.startsWith(path.join(root, 's1'))).toBe(true);
    expect(saved.endsWith('-log.txt')).toBe(true);
    expect(fs.readFileSync(saved, 'utf8')).toBe('hello');
    expect(r.infos).toEqual([
      { name: 'shot.png', mimeType: 'image/png', size: 8 },
      { name: 'log.txt', mimeType: 'text/plain', size: 5 },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('保存先が無いときは画像以外を受け付けない', () => {
    expect(() => buildUserContent('s1', '', [{ name: 'a.pdf', mimeType: 'application/pdf', data: 'AAAA' }], undefined)).toThrow('画像以外');
  });

  it('ファイル名からフォルダと使えない文字を落とす', () => {
    expect(safeFileName('..\\..\\evil:name?.txt')).toBe('evil_name_.txt');
    expect(safeFileName('/etc/passwd')).toBe('passwd');
    expect(safeFileName('...')).toBe('file');
  });

  it('送信すると画像つきの user メッセージを書き、記録には添付の情報だけを残す', async () => {
    const { launcher, clis, specs } = launcherWith();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apwa-att-'));
    const events: DriverEvent[] = [];
    const session = new ClaudeSession({ sessionId: 's1', cwd: '/w', permissionMode: 'auto' }, (e) => events.push(e), {
      launcher,
      claudePath: 'claude',
      env: {},
      attachments: createLocalAttachmentStore(root),
    });
    await session.init();
    await session.send({ type: 'send', text: '', attachments: [{ name: 'shot.png', mimeType: 'image/png', data: PNG }] });
    await new Promise((r) => setTimeout(r, 10));
    const args = specs[0].args;
    expect(args[args.indexOf('--add-dir') + 1]).toBe(path.join(root, 's1'));
    const user = clis[0].written.find((m) => m.type === 'user');
    expect(user.message.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
    expect(events.find((e) => e.type === 'message')).toMatchObject({ role: 'user', text: '', attachments: [{ name: 'shot.png', mimeType: 'image/png', size: 8 }] });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('スラッシュコマンド', () => {
  it('initialize の commands を一覧にする（内部用と重複は除く）', () => {
    expect(
      parseCommands([
        { name: 'compact', description: '要約', argumentHint: '<指示>' },
        { name: '__internal', description: 'x' },
        { name: '/review', description: '', argumentHint: '' },
        { name: 'compact' },
        { description: '名前なし' },
      ]),
    ).toEqual([{ name: 'compact', description: '要約', argumentHint: '<指示>' }, { name: 'review' }]);
    expect(parseCommands(undefined)).toEqual([]);
  });

  it('listCommands は CLI を短く起動して initialize を聞く', async () => {
    const { launcher, specs } = launcherWith((msg, cli) => {
      if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
        cli.out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [{ name: 'context', description: '使用量' }] } } });
      }
    });
    const driver = createClaudeDriver({ launcher, claudePath: 'claude', env: {} });
    expect(driver.supportsAttachments).toBe(true);
    await expect(driver.listCommands!('/w')).resolves.toEqual([{ name: 'context', description: '使用量' }]);
    expect(specs[0].cwd).toBe('/w');
  });

  it('引数つきの /model と /effort は Driver が処理する', () => {
    expect(parseLocalCommand('/model sonnet')).toEqual({ model: 'sonnet' });
    expect(parseLocalCommand(' /model default ')).toEqual({ model: null });
    expect(parseLocalCommand('/effort high')).toEqual({ effort: 'high' });
    expect(parseLocalCommand('/effort auto')).toEqual({ effort: null });
    expect(parseLocalCommand('/effort extreme')).toBeNull();
    expect(parseLocalCommand('/model')).toBeNull();
    expect(parseLocalCommand('/compact')).toBeNull();
    expect(parseLocalCommand('/model a b')).toBeNull();
  });

  it('/model を送ると CLI には送らず、モデルを切り替える', async () => {
    const { launcher, clis } = launcherWith();
    const events: DriverEvent[] = [];
    const session = new ClaudeSession({ sessionId: 's1', cwd: '/w', permissionMode: 'auto' }, (e) => events.push(e), { launcher, claudePath: 'claude', env: {} });
    await session.init();
    await session.send({ type: 'send', text: '/model sonnet' });
    expect(clis).toHaveLength(0);
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', text: '/model sonnet' }),
      { type: 'model', model: 'sonnet' },
    ]);
  });
});
