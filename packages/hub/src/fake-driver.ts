// 表示確認用のフェイク Driver。フィクスチャ（DriverEvent の JSONL）を順に流すだけ。
//
// Codex 用 Driver は Codex の担当（GitHub Issue GS-Bacon/AgentPWA#1）なので、それができるまで
// Codex タブの画面はこれで作る。許可要求・質問・ターン終了のところでは、ユーザーの操作を待ってから続きを流す。
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDriver, AgentKind, DriverEvent, DriverSession, StartOptions, UserAction } from '@agentpwa/shared';

export interface FakeDriverOptions {
  kind: AgentKind;
  fixturesDir: string;
  /** イベント間の待ち時間（ms） */
  delayMs?: number;
}

export function loadFixture(file: string): DriverEvent[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .map((l) => JSON.parse(l) as DriverEvent);
}

export function listFixtures(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(dir, f));
}

type Waiter = { kind: 'approval' | 'question' | 'send'; requestId?: string; resolve: (a: UserAction) => void };

class FakeSession implements DriverSession {
  private waiter: Waiter | null = null;
  private stopped = false;
  private cancelled = false;

  constructor(
    private readonly events: DriverEvent[],
    private readonly opts: StartOptions,
    private readonly emit: (e: DriverEvent) => void,
    private readonly delayMs: number,
  ) {}

  run(): void {
    void this.play();
  }

  async send(action: UserAction): Promise<void> {
    if (this.stopped) throw new Error('セッションは終了しています');
    if (action.type === 'set_permission_mode') {
      // どの状態でも受け付け、すぐに反映したことにする
      this.emit({ type: 'permission_mode', mode: action.mode });
      return;
    }
    if (action.type === 'interrupt') {
      this.cancelled = true;
      this.waiter?.resolve(action);
      return;
    }
    const w = this.waiter;
    if (!w) {
      if (action.type === 'send') {
        // 再生中の追加指示は記録だけする
        this.emit({ type: 'message', messageId: `u-${Date.now()}`, role: 'user', text: action.text });
        return;
      }
      throw new Error('この操作を待っていません');
    }
    if (w.kind === 'approval' && (action.type !== 'approve' || action.requestId !== w.requestId)) throw new Error('この許可要求は解決済みです');
    if (w.kind === 'question' && (action.type !== 'answer' || action.requestId !== w.requestId)) throw new Error('この質問は解決済みです');
    if (w.kind === 'send' && action.type !== 'send') throw new Error('指示を待っています');
    this.waiter = null;
    w.resolve(action);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelled = true;
    this.waiter?.resolve({ type: 'interrupt' });
    this.emit({ type: 'status', status: 'stopped' });
  }

  private wait(kind: Waiter['kind'], requestId?: string): Promise<UserAction> {
    return new Promise((resolve) => {
      this.waiter = { kind, requestId, resolve };
    });
  }

  private sleep(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.delayMs));
  }

  private async play(): Promise<void> {
    const evs = [...this.events];
    let i = 0;
    let firstUser = true;
    const skipUntilRunning = () => {
      // フィクスチャ側の resolved と、その直後の running は実際の操作で置き換える
      while (i < evs.length && (evs[i].type === 'approval_resolved' || evs[i].type === 'question_resolved')) i++;
      if (i < evs.length && evs[i].type === 'status' && (evs[i] as { status: string }).status === 'running') i++;
    };
    while (i < evs.length && !this.stopped) {
      if (this.cancelled) {
        this.cancelled = false;
        this.waiter = null;
        this.emit({ type: 'status', status: 'idle', reason: '中断しました' });
        // 中断後は次のターン終了まで飛ばす
        while (i < evs.length && !(evs[i].type === 'status' && (evs[i] as { status: string }).status === 'idle')) i++;
        i++;
        const a = await this.wait('send');
        if (this.stopped) return;
        if (a.type === 'send') {
          this.emit({ type: 'message', messageId: `u-${Date.now()}`, role: 'user', text: a.text });
          this.emit({ type: 'status', status: 'running' });
        }
        continue;
      }
      let ev = evs[i++];
      // フィクスチャ専用の待ち時間指定（DriverEvent ではないので送らない）
      const sleep = ev as unknown as { type: string; ms?: number };
      if (sleep.type === '_sleep') {
        await new Promise((r) => setTimeout(r, sleep.ms ?? 1000));
        continue;
      }
      if (ev.type === 'message' && ev.role === 'user' && firstUser) {
        firstUser = false;
        if (this.opts.initialPrompt) ev = { ...ev, text: this.opts.initialPrompt };
      }
      this.emit(ev);
      if (ev.type === 'approval_request') {
        const next = evs[i];
        if (next?.type === 'status') {
          this.emit(next);
          i++;
        }
        const a = await this.wait('approval', ev.requestId);
        if (this.stopped) return;
        if (a.type === 'interrupt') continue;
        if (a.type === 'approve') {
          this.emit({ type: 'approval_resolved', requestId: ev.requestId, decision: a.decision });
          this.emit({ type: 'status', status: 'running' });
        }
        skipUntilRunning();
      } else if (ev.type === 'question') {
        const next = evs[i];
        if (next?.type === 'status') {
          this.emit(next);
          i++;
        }
        const a = await this.wait('question', ev.requestId);
        if (this.stopped) return;
        if (a.type === 'interrupt') continue;
        if (a.type === 'answer') {
          this.emit({ type: 'message', messageId: `u-${Date.now()}`, role: 'user', text: a.text });
          this.emit({ type: 'question_resolved', requestId: ev.requestId });
          this.emit({ type: 'status', status: 'running' });
        }
        skipUntilRunning();
      } else if (ev.type === 'status' && ev.status === 'idle' && i < evs.length) {
        const a = await this.wait('send');
        if (this.stopped) return;
        if (a.type === 'interrupt') continue;
        if (a.type === 'send') {
          this.emit({ type: 'message', messageId: `u-${Date.now()}`, role: 'user', text: a.text });
          // フィクスチャ側の次のユーザー発言は実際の指示で置き換える
          if (evs[i]?.type === 'message' && (evs[i] as { role: string }).role === 'user') i++;
        }
      }
      await this.sleep();
    }
    // 再生が終わったら、以降の指示には定型文で返す
    while (!this.stopped) {
      const a = await this.wait('send');
      if (this.stopped || a.type !== 'send') continue;
      this.emit({ type: 'message', messageId: `u-${Date.now()}`, role: 'user', text: a.text });
      this.emit({ type: 'status', status: 'running' });
      await this.sleep();
      this.emit({ type: 'message', messageId: `a-${Date.now()}`, role: 'assistant', text: '（フェイク Driver: フィクスチャの再生は終わりました）' });
      this.emit({ type: 'status', status: 'idle' });
    }
  }
}

export interface FakeDriver extends AgentDriver {
  /** deleteHistory が呼ばれた記録（テストと表示確認用。実際には何も消さない） */
  readonly deletedHistories: { cwd: string; resumeToken: string }[];
}

export function createFakeDriver(options: FakeDriverOptions): FakeDriver {
  let counter = 0;
  const delayMs = options.delayMs ?? 600;
  const deletedHistories: { cwd: string; resumeToken: string }[] = [];
  return {
    kind: options.kind,
    deletedHistories,
    async checkAuth() {
      const n = listFixtures(options.fixturesDir).length;
      return {
        ok: n > 0,
        version: 'fake',
        auth: 'subscription',
        detail: n > 0 ? `表示確認用のフェイク Driver（フィクスチャ ${n} 本）` : `フィクスチャがありません（${options.fixturesDir}）`,
      };
    },
    async start(opts, emit) {
      const files = listFixtures(options.fixturesDir);
      if (files.length === 0) throw new Error('フィクスチャがありません');
      // 再開時は、フィクスチャを流さずに指示を待つだけにする
      const events = opts.resumeToken
        ? ([{ type: 'status', status: 'idle' }] as DriverEvent[])
        : loadFixture(files[counter++ % files.length]);
      const s = new FakeSession(events, opts, emit, delayMs);
      // 起動したら、使っている権限モードを知らせる（docs/protocol.md 3.1）
      emit({ type: 'permission_mode', mode: opts.permissionMode });
      s.run();
      return s;
    },
    async deleteHistory(target) {
      deletedHistories.push(target);
    },
  };
}
