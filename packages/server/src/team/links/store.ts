import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import { opHash } from '@dispatch/protocol/federation';
import { Database } from 'bun:sqlite';

/** Ops of one publisher a link keeps parked at most (FW-R37). */
export const MAX_PARKED_PER_PUBLISHER = 256;
/** Payloads waiting for the link to be ready, at most (FW-R31(4)). */
const MAX_OUTBOX = 1000;

export interface LinkCursor {
  seq: number;
  hash: string;
  hlc: string;
}

export interface LinkProblem {
  subject: string;
  message: string;
  at: string;
  /** False for a fork or a broken chain: the note stays until a person acts. */
  dismissible: boolean;
}

// One link's state in its own SQLite file: its own log, the peer's cursor,
// every peer op hash verified here (kept forever, FW-R36), the local outbox,
// parked ops and problems.
export class LinkStore {
  readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS own_ops (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kept (replica TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (replica, seq));
      CREATE TABLE IF NOT EXISTS cursor (replica TEXT PRIMARY KEY, seq INTEGER NOT NULL, hash TEXT NOT NULL, hlc TEXT NOT NULL, halted TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parked (replica TEXT NOT NULL, seq INTEGER NOT NULL, op_json TEXT NOT NULL, PRIMARY KEY (replica, seq));
      CREATE TABLE IF NOT EXISTS problems (subject TEXT PRIMARY KEY, message TEXT NOT NULL, at TEXT NOT NULL, dismissible INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  ownLog(): LogEntry[] {
    return this.db
      .query<{ json: string }, []>('SELECT json FROM own_ops ORDER BY seq')
      .all()
      .map((r) => JSON.parse(r.json) as LogEntry);
  }

  ownHead(): LogEntry | null {
    const row = this.db
      .query<{ json: string }, []>(
        'SELECT json FROM own_ops ORDER BY seq DESC LIMIT 1'
      )
      .get();
    return row === null ? null : (JSON.parse(row.json) as LogEntry);
  }

  appendOwn(op: FederatedOp): void {
    this.db
      .query('INSERT INTO own_ops (seq, json) VALUES (?, ?)')
      .run(op.seq, JSON.stringify(op));
  }

  /** Replaces own ops the branch pruned with their stubs. */
  stubOwn(stubs: readonly LogEntry[]): void {
    const q = this.db.query('UPDATE own_ops SET json = ? WHERE seq = ?');
    for (const s of stubs) q.run(JSON.stringify(s), s.seq);
  }

  /** The hash this machine verified for (replica, seq), or null. */
  kept(replica: string, seq: number): string | null {
    return (
      this.db
        .query<{ hash: string }, [string, number]>(
          'SELECT hash FROM kept WHERE replica = ? AND seq = ?'
        )
        .get(replica, seq)?.hash ?? null
    );
  }

  keep(replica: string, seq: number, hash: string): void {
    this.db
      .query('INSERT OR IGNORE INTO kept (replica, seq, hash) VALUES (?, ?, ?)')
      .run(replica, seq, hash);
  }

  cursor(replica: string): (LinkCursor & { halted: string | null }) | null {
    return this.db
      .query<LinkCursor & { halted: string | null }, [string]>(
        'SELECT seq, hash, hlc, halted FROM cursor WHERE replica = ?'
      )
      .get(replica);
  }

  advance(replica: string, c: LinkCursor): void {
    this.db
      .query(
        `INSERT INTO cursor (replica, seq, hash, hlc, halted) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(replica) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, hlc = excluded.hlc`
      )
      .run(replica, c.seq, c.hash, c.hlc);
  }

  halt(replica: string, why: string): void {
    this.db
      .query(
        `INSERT INTO cursor (replica, seq, hash, hlc, halted) VALUES (?, 0, '', '', ?)
         ON CONFLICT(replica) DO UPDATE SET halted = excluded.halted`
      )
      .run(replica, why);
  }

  queue(payloadJson: string): boolean {
    const n =
      this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM outbox').get()
        ?.n ?? 0;
    if (n >= MAX_OUTBOX) return false;
    this.db
      .query('INSERT INTO outbox (payload_json) VALUES (?)')
      .run(payloadJson);
    return true;
  }

  outbox(): { id: number; payloadJson: string }[] {
    return this.db
      .query<{ id: number; payloadJson: string }, []>(
        'SELECT id, payload_json AS payloadJson FROM outbox ORDER BY id'
      )
      .all();
  }

  dequeue(id: number): void {
    this.db.query('DELETE FROM outbox WHERE id = ?').run(id);
  }

  /** Parks an op for a later pass; false when its publisher is at the cap. */
  park(op: FederatedOp): boolean {
    const n =
      this.db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM parked WHERE replica = ?'
        )
        .get(op.replica)?.n ?? 0;
    if (n >= MAX_PARKED_PER_PUBLISHER) return false;
    this.db
      .query(
        'INSERT OR IGNORE INTO parked (replica, seq, op_json) VALUES (?, ?, ?)'
      )
      .run(op.replica, op.seq, JSON.stringify(op));
    return true;
  }

  /** Parked ops, oldest first, each only while it matches its kept hash (FW-R37). */
  parked(replica: string): FederatedOp[] {
    const out: FederatedOp[] = [];
    for (const row of this.db
      .query<{ seq: number; op_json: string }, [string]>(
        'SELECT seq, op_json FROM parked WHERE replica = ? ORDER BY seq'
      )
      .all(replica)) {
      const op = JSON.parse(row.op_json) as FederatedOp;
      if (this.kept(replica, row.seq) === opHash(op)) out.push(op);
      else this.release(replica, row.seq);
    }
    return out;
  }

  release(replica: string, seq: number): void {
    this.db
      .query('DELETE FROM parked WHERE replica = ? AND seq = ?')
      .run(replica, seq);
  }

  problem(subject: string, message: string, dismissible = true): void {
    this.db
      .query(
        `INSERT INTO problems (subject, message, at, dismissible) VALUES (?, ?, ?, ?)
         ON CONFLICT(subject) DO UPDATE SET message = excluded.message, at = excluded.at, dismissible = excluded.dismissible`
      )
      .run(subject, message, this.now().toISOString(), dismissible ? 1 : 0);
  }

  clearProblem(subject: string): void {
    this.db.query('DELETE FROM problems WHERE subject = ?').run(subject);
  }

  problems(): LinkProblem[] {
    return this.db
      .query<
        { subject: string; message: string; at: string; dismissible: number },
        []
      >(
        'SELECT subject, message, at, dismissible FROM problems ORDER BY subject'
      )
      .all()
      .map((r) => ({ ...r, dismissible: r.dismissible === 1 }));
  }

  getMeta(k: string): string | null {
    return (
      this.db
        .query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?')
        .get(k)?.v ?? null
    );
  }

  setMeta(k: string, v: string): void {
    this.db
      .query(
        'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
      )
      .run(k, v);
  }
}
