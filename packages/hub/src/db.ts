// SQLite への保存（Node 組み込みの node:sqlite を使う。ネイティブモジュールのビルドが要らない）。
import { DatabaseSync } from 'node:sqlite';
import type { SessionEvent } from '@agentpwa/shared';
import type { SessionRecord } from './state.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  message_id TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS events_delta ON events (session_id, message_id) WHERE type = 'message_delta';
`;

export class Store {
  private db: DatabaseSync;
  private stmts;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.stmts = {
      upsertSession: this.db.prepare(
        'INSERT INTO sessions (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      ),
      allSessions: this.db.prepare('SELECT data FROM sessions'),
      insertEvent: this.db.prepare('INSERT OR REPLACE INTO events (session_id, seq, type, message_id, data) VALUES (?, ?, ?, ?, ?)'),
      deleteDeltas: this.db.prepare("DELETE FROM events WHERE session_id = ? AND type = 'message_delta' AND message_id = ?"),
      eventsAfter: this.db.prepare('SELECT data FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      maxSeq: this.db.prepare('SELECT MAX(seq) AS m FROM events WHERE session_id = ?'),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      deleteEvents: this.db.prepare('DELETE FROM events WHERE session_id = ?'),
    };
  }

  /** セッションとそのイベントをすべて消す（元に戻せない） */
  deleteSession(sessionId: string): void {
    this.transaction(() => {
      this.stmts.deleteEvents.run(sessionId);
      this.stmts.deleteSession.run(sessionId);
    });
  }

  loadSessions(): SessionRecord[] {
    return (this.stmts.allSessions.all() as { data: string }[]).map((r) => JSON.parse(r.data) as SessionRecord);
  }

  saveSession(rec: SessionRecord): void {
    this.stmts.upsertSession.run(rec.id, JSON.stringify(rec), rec.updatedAt);
  }

  insertEvent(ev: SessionEvent): void {
    const messageId = ev.type === 'message_delta' ? ev.messageId : null;
    this.stmts.insertEvent.run(ev.sessionId, ev.seq, ev.type, messageId, JSON.stringify(ev));
    // 完成版のメッセージが来たら、同じ messageId の断片は不要になるので消す
    if (ev.type === 'message') this.stmts.deleteDeltas.run(ev.sessionId, ev.messageId);
  }

  eventsAfter(sessionId: string, afterSeq: number, limit = 5000): SessionEvent[] {
    return (this.stmts.eventsAfter.all(sessionId, afterSeq, limit) as { data: string }[]).map((r) => JSON.parse(r.data) as SessionEvent);
  }

  maxSeq(sessionId: string): number {
    const row = this.stmts.maxSeq.get(sessionId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
