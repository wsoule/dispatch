import { openSqliteDb } from '@dispatch/core';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryBusyError, MemoryError } from '../src/errors.js';
import { MEMORY_DB_VERSION, openMemoryDb } from '../src/schema.js';
import { SqliteMemoryStore } from '../src/sqliteStore.js';

// Only the file-backed cases set `dir`; the ':memory:' ones leave it unset.
let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDb(): string {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'memdb-')));
  return join(dir, 'memory.db');
}

describe('openMemoryDb', () => {
  it('opens with FTS5 on the pinned runtime', () => {
    const { db, search } = openMemoryDb(':memory:');
    expect(search).toBe('fts5');
    db.close();
  });

  it('opens in LIKE mode when told FTS is off', () => {
    const { db, search } = openMemoryDb(':memory:', { fts: 'off' });
    expect(search).toBe('like');
    db.close();
  });

  it('waits at most 100 ms on a busy file, then refuses as busy instead of stalling', () => {
    const path = tempDb();
    const opened = openMemoryDb(path);
    const [row] = opened.db.prepare('PRAGMA busy_timeout').all() as {
      timeout: number;
    }[];
    expect(row.timeout).toBeLessThanOrEqual(100);
    const store = new SqliteMemoryStore(opened);
    const other = openSqliteDb(path);
    other.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    try {
      expect(() => store.transaction(() => 1)).toThrow(MemoryBusyError);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(store.transaction(() => 2)).toBe(2);
    opened.db.close();
  });

  it('makes the database and its WAL files 0600', () => {
    const path = tempDb();
    const { db } = openMemoryDb(path);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(`${path}-wal`)).toBe(true);
    db.close();
  });

  it('opens an additively newer file and leaves its version alone', () => {
    const path = tempDb();
    openMemoryDb(path).db.close();
    const raw = openSqliteDb(path);
    raw.exec('PRAGMA user_version = 5');
    raw.close();
    const { db } = openMemoryDb(path);
    expect(
      (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
    ).toBe(5);
    db.close();
  });

  it('refuses a file whose min_reader_version is above this build', () => {
    const path = tempDb();
    openMemoryDb(path).db.close();
    const raw = openSqliteDb(path);
    raw
      .prepare("UPDATE meta SET value = ? WHERE key = 'min_reader_version'")
      .run(String(MEMORY_DB_VERSION + 1));
    raw.close();
    let caught: unknown;
    try {
      openMemoryDb(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).code).toBe('unavailable');
    expect((caught as MemoryError).message).toContain(
      'written by a newer Dispatch'
    );
  });

  it('rebuilds the FTS index when a LIKE-mode file is reopened with FTS', () => {
    const path = tempDb();
    const like = openMemoryDb(path, { fts: 'off' });
    like.db.exec(
      "INSERT INTO entries (id, handle, scope, kind, title, body, refs, applies_to, author, trust, status, decay, pinned, rev, content_hash, created_at, updated_at, recall_count) VALUES ('mem-A', '#AAAAAAAA', 'team', 'hazard', 'flaky server tests', 'b', '[]', '[]', 'agent:dispatch', 'agent', 'active', 'fresh', 0, 1, 'h', 'now', 'now', 0)"
    );
    like.db.close();
    const { db, search } = openMemoryDb(path);
    expect(search).toBe('fts5');
    expect(
      db
        .prepare(
          'SELECT rowid FROM entries_fts WHERE entries_fts MATCH \'"flaky"\''
        )
        .all()
    ).toHaveLength(1);
    db.close();
  });
});
