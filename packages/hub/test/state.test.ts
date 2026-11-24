import { describe, expect, it } from 'vitest';
import type { DriverEvent, SessionEvent } from '@agentpwa/shared';
import { applyEvent, isUnread, markRead, newRecord, rankOf, recoverAfterRestart, sortRecords, titleFromPrompt, type SessionRecord } from '../src/state.ts';

function rec(id = 's1', now = '2026-11-24T00:00:00.000Z'): SessionRecord {
  return newRecord({ id, agent: 'claude', title: 't', cwd: 'C:\\w', folderName: 'w', permissionMode: 'ask', now });
}

/** イベント列を順に適用する（seq と時刻は自動で振る）。 */
function play(r: SessionRecord, events: DriverEvent[], startMinute = 1): SessionRecord {
  let cur = r;
  events.forEach((e, i) => {
    const at = new Date(Date.UTC(2026, 10, 24, 0, startMinute + i)).toISOString();
    cur = applyEvent(cur, { ...e, sessionId: cur.id, seq: cur.lastSeq + 1, at } as SessionEvent);
  });
  return cur;
}

describe('状態遷移', () => {
  it('starting → running → waiting_approval → running → idle', () => {
    let r = rec();
    r = play(r, [{ type: 'status', status: 'running' }]);
    expect(r.status).toBe('running');
    r = play(r, [
      { type: 'approval_request', requestId: 'p1', kind: 'command', title: 'コマンドの実行許可', command: 'npm test', choices: ['allow', 'deny'] },
      { type: 'status', status: 'waiting_approval' },
    ], 2);
    expect(r.status).toBe('waiting_approval');
    expect(r.pendingApprovals.map((a) => a.requestId)).toEqual(['p1']);
    expect(r.activity).toBe('コマンドの実行許可: npm test');
    r = play(r, [
      { type: 'approval_resolved', requestId: 'p1', decision: 'allow' },
      { type: 'status', status: 'running' },
    ], 4);
    expect(r.status).toBe('running');
    expect(r.pendingApprovals).toEqual([]);
    r = play(r, [{ type: 'status', status: 'idle' }], 6);
    expect(r.status).toBe('idle');
    expect(r.lastSeq).toBe(6);
  });

  it('許可要求が複数あれば、すべて解決するまで残る', () => {
    let r = play(rec(), [
      { type: 'status', status: 'running' },
      { type: 'approval_request', requestId: 'a', kind: 'command', title: 'x', choices: ['allow'] },
      { type: 'approval_request', requestId: 'b', kind: 'command', title: 'y', choices: ['allow'] },
      { type: 'status', status: 'waiting_approval' },
      { type: 'approval_resolved', requestId: 'a', decision: 'allow' },
    ]);
    expect(r.pendingApprovals.map((a) => a.requestId)).toEqual(['b']);
    expect(r.status).toBe('waiting_approval');
  });

  it('質問は waiting_input → question_resolved → running', () => {
    let r = play(rec(), [
      { type: 'status', status: 'running' },
      { type: 'question', requestId: 'q1', prompt: '443 と 8443 のどちらにしますか？', options: ['443', '8443'] },
      { type: 'status', status: 'waiting_input' },
    ]);
    expect(rankOf(r)).toBe(2);
    expect(r.pendingQuestions).toHaveLength(1);
    r = play(r, [{ type: 'question_resolved', requestId: 'q1' }, { type: 'status', status: 'running' }], 5);
    expect(r.pendingQuestions).toEqual([]);
    expect(rankOf(r)).toBe(4);
  });

  it('stopped になったら未解決の要求を消す', () => {
    const r = play(rec(), [
      { type: 'status', status: 'running' },
      { type: 'approval_request', requestId: 'a', kind: 'command', title: 'x', choices: ['allow'] },
      { type: 'status', status: 'waiting_approval' },
      { type: 'status', status: 'stopped' },
    ]);
    expect(r.pendingApprovals).toEqual([]);
    expect(rankOf(r)).toBe(5);
  });

  it('resume_token を覚える', () => {
    const r = play(rec(), [{ type: 'resume_token', token: 'abc' }]);
    expect(r.resumeToken).toBe('abc');
  });

  it('permission_mode を現在の権限モードにする', () => {
    let r = play(rec(), [{ type: 'permission_mode', mode: 'plan' }]);
    expect(r.permissionMode).toBe('plan');
    r = play(r, [{ type: 'error', message: '切り替えられません', fatal: false }], 2);
    expect(r.permissionMode).toBe('plan');
    r = play(r, [{ type: 'permission_mode', mode: 'auto' }], 3);
    expect(r.permissionMode).toBe('auto');
  });

  it('状態が変わらない status では statusSince を変えない', () => {
    const r1 = play(rec(), [{ type: 'status', status: 'running' }]);
    const r2 = play(r1, [{ type: 'status', status: 'running' }], 10);
    expect(r2.statusSince).toBe(r1.statusSince);
  });
});

describe('既読管理', () => {
  it('作業後に idle になると未読、読むと既読', () => {
    let r = play(rec(), [{ type: 'status', status: 'running' }, { type: 'message', messageId: 'm', role: 'assistant', text: '完了しました' }, { type: 'status', status: 'idle' }]);
    expect(isUnread(r)).toBe(true);
    expect(rankOf(r)).toBe(3);
    r = markRead(r);
    expect(isUnread(r)).toBe(false);
    expect(rankOf(r)).toBe(5);
  });

  it('起動直後の idle（作業していない）は未読にしない', () => {
    const r = play(rec(), [{ type: 'status', status: 'idle' }]);
    expect(isUnread(r)).toBe(false);
  });

  it('古い seq で既読にしても、後のターン終了は未読のまま', () => {
    let r = play(rec(), [{ type: 'status', status: 'running' }]);
    const seenAt = r.lastSeq;
    r = play(r, [{ type: 'status', status: 'idle' }], 3);
    r = markRead(r, seenAt);
    expect(isUnread(r)).toBe(true);
  });

  it('readSeq は戻らず、lastSeq を超えない', () => {
    let r = play(rec(), [{ type: 'status', status: 'running' }, { type: 'status', status: 'idle' }]);
    r = markRead(r, 999);
    expect(r.readSeq).toBe(r.lastSeq);
    const same = markRead(r, 1);
    expect(same).toBe(r);
  });
});

describe('並べ替え', () => {
  it('許可待ち → 質問 → 完了・未読 → 実行中 → アイドルの順', () => {
    const idleRead = markRead(play(rec('idle-read'), [{ type: 'status', status: 'running' }, { type: 'status', status: 'idle' }]));
    const running = play(rec('running'), [{ type: 'status', status: 'running' }]);
    const unread = play(rec('unread'), [{ type: 'status', status: 'running' }, { type: 'status', status: 'idle' }]);
    const question = play(rec('question'), [{ type: 'status', status: 'waiting_input' }]);
    const approval = play(rec('approval'), [{ type: 'status', status: 'waiting_approval' }]);
    const stopped = play(rec('stopped'), [{ type: 'status', status: 'stopped' }]);
    const sorted = sortRecords([idleRead, running, stopped, unread, question, approval]).map((r) => r.id);
    expect(sorted.slice(0, 4)).toEqual(['approval', 'question', 'unread', 'running']);
    expect(sorted.slice(4).sort()).toEqual(['idle-read', 'stopped']);
  });

  it('同じ順位では待ちが長い順', () => {
    const early = play(rec('early'), [{ type: 'status', status: 'waiting_approval' }], 1);
    const late = play(rec('late'), [{ type: 'status', status: 'waiting_approval' }], 30);
    expect(sortRecords([late, early]).map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('アイドル・停止は最近動いた順', () => {
    const old = play(rec('old'), [{ type: 'status', status: 'stopped' }], 1);
    const recent = play(rec('recent'), [{ type: 'status', status: 'stopped' }], 50);
    expect(sortRecords([old, recent]).map((r) => r.id)).toEqual(['recent', 'old']);
  });
});

describe('Hub 再起動', () => {
  it('作業中だったセッションは stopped にする', () => {
    for (const status of ['starting', 'running', 'waiting_approval', 'waiting_input'] as const) {
      const r = play(rec(), [{ type: 'status', status }]);
      expect(recoverAfterRestart(r)?.status).toBe('stopped');
    }
  });

  it('idle / stopped / error はそのまま', () => {
    for (const status of ['idle', 'stopped', 'error'] as const) {
      const r = play(rec(), [{ type: 'status', status }]);
      expect(recoverAfterRestart(r)).toBeNull();
    }
  });
});

describe('セッション名', () => {
  it('既定の名前なら、最初のユーザー発言を名前にする', () => {
    const r = play({ ...rec(), title: '新しいセッション' }, [{ type: 'message', messageId: 'u', role: 'user', text: 'CI を直して' }]);
    expect(r.title).toBe('CI を直して');
    const r2 = play(r, [{ type: 'message', messageId: 'u2', role: 'user', text: '別の話' }]);
    expect(r2.title).toBe('CI を直して');
  });
});

describe('titleFromPrompt', () => {
  it('最初の行を40文字までにする', () => {
    expect(titleFromPrompt('\nPWAの雛形を作成\n詳細')).toBe('PWAの雛形を作成');
    expect(titleFromPrompt('')).toBe('新しいセッション');
    expect(titleFromPrompt('あ'.repeat(50))).toHaveLength(40);
  });
});
