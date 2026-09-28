import { queryAll, queryOne } from '@dispatch/core';
import type { SqliteDatabase, SqlValue } from '@dispatch/core';
import { MemoryError, openMemoryDb, SqliteMemoryStore } from '@dispatch/memory';
import type { MemoryStore } from '@dispatch/memory';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { IDENTITY_PATTERN } from './identities.js';

interface OpenStore {
  store: SqliteMemoryStore;
  db: SqliteDatabase;
}

// Everything of a person's that rides along with their entries in a move.
const CARRIED = [
  'revisions',
  'recalls',
  'activity',
  'ingest_problems',
  'deleted_origins',
] as const;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function columnsOf(db: SqliteDatabase, table: string): string[] {
  return queryAll<{ name: string }>(db, `PRAGMA table_info(${table})`).map(
    (r) => r.name
  );
}

// Columns both files have, so an additively newer file still moves; `seq` is
// the target's own rowid.
function sharedColumns(
  from: SqliteDatabase,
  to: SqliteDatabase,
  table: string
): string[] {
  const theirs = new Set(columnsOf(to, table));
  return columnsOf(from, table).filter((c) => c !== 'seq' && theirs.has(c));
}

// Copies every row of `table`; `skip` leaves out rows the target already holds.
function copyTable(
  from: SqliteDatabase,
  to: SqliteDatabase,
  table: string,
  skip: (row: Record<string, SqlValue>) => boolean
): number {
  const columns = sharedColumns(from, to, table);
  const list = columns.map((c) => `"${c}"`).join(', ');
  const rows = queryAll<Record<string, SqlValue>>(
    from,
    `SELECT ${list} FROM ${table}`
  );
  const verb = table === 'entries' ? 'INSERT' : 'INSERT OR IGNORE';
  const insert = to.prepare(
    `${verb} INTO ${table} (${list}) VALUES (${columns.map(() => '?').join(', ')})`
  );
  for (const row of rows) {
    if (!skip(row)) insert.run(...columns.map((c) => row[c]));
  }
  return rows.length;
}

// The personal databases, one <identity>.db per human under one directory,
// opened on first use and kept open.
export class PersonalStores {
  private readonly dir: string;
  private readonly fts: 'auto' | 'off';
  private readonly stores = new Map<string, OpenStore>();

  constructor(opts: { dir: string; fts?: 'auto' | 'off' }) {
    this.dir = opts.dir;
    this.fts = opts.fts ?? 'auto';
  }

  /** Throws MemoryError('unavailable') when the file will not open; a later call retries. */
  personal(identity: string): MemoryStore {
    return this.open(identity).store;
  }

  /** The first of `identities` whose store holds `id`; a store that will not open is skipped. */
  locate(id: string, identities: readonly string[]): string | null {
    for (const identity of identities) {
      let store: MemoryStore;
      try {
        store = this.personal(identity);
      } catch (err) {
        if (err instanceof MemoryError) continue;
        throw err;
      }
      if (store.getEntry(id) !== null) return identity;
    }
    return null;
  }

  opened(): string[] {
    return [...this.stores.keys()].sort();
  }

  // Where `identity`'s database lives, whether or not it is open.
  pathOf(identity: string): string {
    return join(this.dir, `${identity}.db`);
  }

  // Empties `from` into `to`, returning how many entries left. `to` commits while
  // `from` stays locked, so a retry after a crash skips the ids `to` already holds.
  move(from: string, to: string): number {
    if (from === to) return 0;
    const source = this.open(from);
    const target = this.open(to);
    return source.store.transaction(() => {
      const moved = target.store.transaction(() => {
        const held = (row: Record<string, SqlValue>) =>
          queryOne(target.db, 'SELECT 1 AS one FROM entries WHERE id = ?', [
            row.id,
          ]) !== undefined;
        const count = copyTable(source.db, target.db, 'entries', held);
        for (const table of CARRIED)
          copyTable(source.db, target.db, table, () => false);
        return count;
      });
      for (const table of ['entries', ...CARRIED])
        source.db.exec(`DELETE FROM ${table}`);
      return moved;
    });
  }

  close(): void {
    for (const { store } of this.stores.values()) store.close();
    this.stores.clear();
  }

  private open(identity: string): OpenStore {
    const cached = this.stores.get(identity);
    if (cached !== undefined) return cached;
    try {
      if (!IDENTITY_PATTERN.test(identity))
        throw new Error(
          `${JSON.stringify(identity)} is not a personal memory identity`
        );
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        // A filesystem without POSIX modes is not a reason to refuse the store.
      }
      const opened = openMemoryDb(this.pathOf(identity), {
        fts: this.fts,
      });
      const entry = { db: opened.db, store: new SqliteMemoryStore(opened) };
      this.stores.set(identity, entry);
      return entry;
    } catch (err) {
      throw new MemoryError(
        'unavailable',
        `personal memory unavailable: ${message(err)}`,
        'store'
      );
    }
  }
}
