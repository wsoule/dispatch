import { aheadOfClock, OpClock } from '@dispatch/protocol/federation';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BoardOp, HeldField, MergeState } from './engine.js';

// Everything one replica remembers about board sync, in one SQLite file under
// its sync directory (boardSyncDir): who it is, the merge state core's
// boardSync.ts folds changes into, its clock, the changes it has made but not
// yet sent, and how far it has read each other replica's log.
//
// A database rather than JSON files because the merge state is written on
// every task edit and read on every change applied, and because a change must
// land in the merge state and the outbox together or not at all — a crash
// between the two would either send a change this replica does not remember
// making, or remember one it never sends.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fields (
  task TEXT NOT NULL, field TEXT NOT NULL, hlc TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (task, field)
);
CREATE TABLE IF NOT EXISTS tombstones (task TEXT PRIMARY KEY, hlc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS origins (task TEXT PRIMARY KEY, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (
  task TEXT NOT NULL, hlc TEXT NOT NULL, idx INTEGER NOT NULL, line TEXT NOT NULL,
  PRIMARY KEY (task, hlc, idx)
);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (replica TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS problems (task TEXT PRIMARY KEY, message TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** A problem sync hit and could not resolve itself, for a person to act on. */
export interface SyncProblem {
  task: string;
  message: string;
  at: string;
}

/** A replica id: the lowercased handle, since ids become git paths and sealing
 *  aad, and random hex, so two of one person's machines are two replicas. */
export function newReplicaId(handle: string): string {
  const cleaned = handle
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 32);
  const safe = cleaned === '' ? 'replica' : cleaned;
  return `${safe}-${randomBytes(4).toString('hex')}`;
}

export class SyncLedger {
  readonly replica: string;
  readonly clock: OpClock;
  readonly state: MergeState;
  private readonly db: Database;

  constructor(
    path: string,
    handle: string,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.replica =
      this.meta('replica') ?? this.setMeta('replica', newReplicaId(handle));
    this.clock = new OpClock(this.replica, this.meta('hlc') ?? null, now);
    this.state = this.mergeState();
  }

  close(): void {
    this.db.close();
  }

  /** The one connection, so the federation tables share this file's transactions. */
  get database(): Database {
    return this.db;
  }

  private meta(key: string): string | undefined {
    const row = this.db
      .query<{ value: string }, [string]>(
        'SELECT value FROM meta WHERE key = ?'
      )
      .get(key);
    return row?.value;
  }

  private setMeta(key: string, value: string): string {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
    return value;
  }

  /** Runs `fn` as one transaction: all of it lands, or none of it. */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Stamps and records a change this replica made, queuing it to send.
   *  `recordLocal` is passed in so this file stays free of merge logic. */
  commitLocal(
    change: Omit<BoardOp, 'v' | 'replica' | 'seq' | 'hlc'>,
    recordLocal: (op: BoardOp, state: MergeState) => void
  ): BoardOp {
    return this.atomically(() => {
      const seq = Number(this.meta('seq') ?? '0') + 1;
      const op: BoardOp = {
        v: 1,
        replica: this.replica,
        seq,
        hlc: this.clock.tick(),
        ...change,
      };
      recordLocal(op, this.state);
      this.db
        .query('INSERT INTO outbox (seq, op) VALUES (?, ?)')
        .run(seq, JSON.stringify(op));
      this.setMeta('seq', String(seq));
      this.setMeta('hlc', this.clock.last);
      return op;
    });
  }

  /** The next seq, past both the v1 counter and `atLeast`, and a fresh tick.
   *  Call inside atomically() so the op using them lands in the same write. */
  nextStamp(atLeast: number): { seq: number; hlc: string } {
    const seq = Math.max(Number(this.meta('seq') ?? '0'), atLeast) + 1;
    const hlc = this.clock.tick();
    this.setMeta('seq', String(seq));
    this.setMeta('hlc', this.clock.last);
    return { seq, hlc };
  }

  /** A v1 copy of a signed op, under that op's own seq, for older builds
   *  while the legacy window is open. */
  enqueueV1(op: BoardOp): void {
    this.db
      .query('INSERT OR REPLACE INTO outbox (seq, op) VALUES (?, ?)')
      .run(op.seq, JSON.stringify(op));
  }

  /** The highest seq minted on this root, by this build or an older one. */
  lastSeq(): number {
    return Number(this.meta('seq') ?? '0');
  }

  /** Changes made here and not yet written to the sync branch, oldest first. */
  outbox(): BoardOp[] {
    return this.db
      .query<{ op: string }, []>('SELECT op FROM outbox ORDER BY seq')
      .all()
      .map((row) => JSON.parse(row.op) as BoardOp);
  }

  /** Forgets outbox entries once they are committed to the sync branch. */
  sent(throughSeq: number): void {
    this.db.query('DELETE FROM outbox WHERE seq <= ?').run(throughSeq);
  }

  /** How far this replica has read another's log. */
  cursor(replica: string): number {
    const row = this.db
      .query<{ seq: number }, [string]>(
        'SELECT seq FROM cursors WHERE replica = ?'
      )
      .get(replica);
    return row?.seq ?? 0;
  }

  setCursor(replica: string, seq: number): void {
    this.db
      .query(
        'INSERT INTO cursors (replica, seq) VALUES (?, ?) ON CONFLICT(replica) DO UPDATE SET seq = excluded.seq'
      )
      .run(replica, seq);
  }

  /** Moves the clock past a remote change and remembers where it got to. */
  observe(hlc: string): void {
    if (this.clock.observe(hlc)) this.setMeta('hlc', this.clock.last);
  }

  /** Whether a reading is too far ahead of this machine's clock to apply yet
   *  (FW-R21): such a change waits, unapplied and unobserved. */
  ahead(hlc: string): boolean {
    return aheadOfClock(hlc, this.now());
  }

  isBootstrapped(): boolean {
    return this.meta('bootstrapped') === '1';
  }

  markBootstrapped(): void {
    this.setMeta('bootstrapped', '1');
  }

  recordProblem(task: string, message: string, at: string): void {
    this.db
      .query(
        'INSERT INTO problems (task, message, at) VALUES (?, ?, ?) ON CONFLICT(task) DO UPDATE SET message = excluded.message, at = excluded.at'
      )
      .run(task, message, at);
  }

  clearProblem(task: string): void {
    this.db.query('DELETE FROM problems WHERE task = ?').run(task);
  }

  problems(): SyncProblem[] {
    return this.db
      .query<SyncProblem, []>(
        'SELECT task, message, at FROM problems ORDER BY at'
      )
      .all();
  }

  // The merge state core folds changes into, over the tables above.
  private mergeState(): MergeState {
    const db = this.db;
    const fieldQ = db.query<{ hlc: string; value: string }, [string, string]>(
      'SELECT hlc, value FROM fields WHERE task = ? AND field = ?'
    );
    const fieldsQ = db.query<
      { field: string; hlc: string; value: string },
      [string]
    >('SELECT field, hlc, value FROM fields WHERE task = ?');
    const setFieldQ = db.query(
      'INSERT INTO fields (task, field, hlc, value) VALUES (?, ?, ?, ?) ON CONFLICT(task, field) DO UPDATE SET hlc = excluded.hlc, value = excluded.value'
    );
    const tombQ = db.query<{ hlc: string }, [string]>(
      'SELECT hlc FROM tombstones WHERE task = ?'
    );
    const setTombQ = db.query(
      'INSERT INTO tombstones (task, hlc) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET hlc = excluded.hlc'
    );
    const originQ = db.query<{ origin: string }, [string]>(
      'SELECT origin FROM origins WHERE task = ?'
    );
    const setOriginQ = db.query(
      'INSERT OR IGNORE INTO origins (task, origin) VALUES (?, ?)'
    );
    const addLineQ = db.query(
      'INSERT OR IGNORE INTO activity (task, hlc, idx, line) VALUES (?, ?, ?, ?)'
    );
    const linesQ = db.query<{ line: string }, [string]>(
      'SELECT line FROM activity WHERE task = ? ORDER BY hlc, idx'
    );
    return {
      field: (task, field) => {
        const row = fieldQ.get(task, field);
        return row === null
          ? undefined
          : { hlc: row.hlc, value: JSON.parse(row.value) as unknown };
      },
      setField: (task, field, hlc, value) => {
        setFieldQ.run(task, field, hlc, JSON.stringify(value ?? null));
      },
      fields: (task) => {
        const out: Record<string, HeldField> = {};
        for (const row of fieldsQ.all(task)) {
          out[row.field] = {
            hlc: row.hlc,
            value: JSON.parse(row.value) as unknown,
          };
        }
        return out;
      },
      tombstone: (task) => tombQ.get(task)?.hlc,
      setTombstone: (task, hlc) => void setTombQ.run(task, hlc),
      origin: (task) => originQ.get(task)?.origin,
      setOrigin: (task, origin) => void setOriginQ.run(task, origin),
      addActivity: (task, hlc, index, line) =>
        void addLineQ.run(task, hlc, index, line),
      activity: (task) => linesQ.all(task).map((row) => row.line),
    };
  }
}
