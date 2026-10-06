import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dbVersion, openSqliteDb, queryAll } from '../src/sqliteDb.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('openSqliteDb', () => {
  it('opens a database with no dispatch schema', () => {
    const db = openSqliteDb(':memory:');
    const tables = queryAll<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    expect(tables).toEqual([]);
    expect(dbVersion(db)).toBe(0);
    db.close();
  });

  it('waits briefly on a busy database rather than failing at once or stalling', () => {
    const db = openSqliteDb(':memory:');
    const [row] = queryAll<{ timeout: number }>(db, 'PRAGMA busy_timeout');
    expect(row.timeout).toBeGreaterThan(0);
    expect(row.timeout).toBeLessThanOrEqual(100);
    db.close();
  });

  it('creates missing parent directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-sqlite-'));
    dirs.push(dir);
    const db = openSqliteDb(join(dir, 'nested', 'x.db'));
    db.exec('CREATE TABLE t (a INTEGER)');
    db.close();
  });
});
