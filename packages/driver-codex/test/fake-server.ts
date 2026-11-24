import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Launch, Wire } from '../src/rpc.ts';

/** stdio のフレーミングも通す、推論を呼ばない app-server。 */
export class FakeServer {
  messages: Wire[] = [];
  account: Wire | null = { type: 'chatgpt' };
  config: Wire = { model_provider: 'openai' };
  quota: Wire = { ordinaryUsageAllowed: true, rateLimits: { credits: { hasCredits: false, unlimited: false }, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1800500000 } } };
  models: Wire[] = [{ id: 'gpt-test', model: 'gpt-test', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })) }];
  handler?: (msg: Wire) => Wire | undefined;
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null, kill: (_signal?: string) => { this.close(); return true; } });
  launch: Launch = () => this.child as unknown as ChildProcessWithoutNullStreams;
  private turn = 0;
  constructor() {
    let buffer = '';
    this.child.stdin.on('data', (data: Buffer) => {
      buffer += data.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        const msg = JSON.parse(line) as Wire;
        this.messages.push(msg);
        queueMicrotask(() => {
          if (!msg.method || msg.id === undefined) return;
          const override = this.handler?.(msg);
          if (override?.hold) return;
          const result = override ?? this.result(msg);
          this.emit({ id: msg.id, ...(result.error ? { error: result.error } : { result }) });
          if (msg.method === 'turn/start' && result.turn) {
            queueMicrotask(() => this.notify('turn/started', { threadId: msg.params.threadId, turn: result.turn }));
          }
        });
      }
    });
    this.child.stdin.on('finish', () => this.close());
  }
  private result(msg: Wire): Wire {
    switch (msg.method) {
      case 'config/read': return { config: this.config };
      case 'account/read': return { account: this.account };
      case 'account/rateLimits/read': return this.quota;
      case 'model/list': return { data: this.models, nextCursor: null };
      case 'thread/start':
      case 'thread/resume': return { thread: { id: msg.params.threadId ?? 'thread-test', turns: [] }, model: 'gpt-test', reasoningEffort: 'medium', approvalsReviewer: msg.params.approvalsReviewer };
      case 'turn/start': return { turn: { id: `turn-${++this.turn}`, status: 'inProgress' } };
      default: return {};
    }
  }
  emit(message: Wire) { this.child.stdout.write(JSON.stringify(message) + '\n'); }
  notify(method: string, params: Wire) { this.emit({ method, params }); }
  request(id: number | string, method: string, params: Wire) { this.emit({ id, method, params }); }
  close() {
    if (this.child.exitCode !== null) return;
    this.child.exitCode = 0;
    this.child.stdout.end(); this.child.stderr.end();
    queueMicrotask(() => this.child.emit('close', 0));
  }
}
