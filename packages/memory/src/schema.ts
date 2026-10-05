import { dbVersion, openSqliteDb, queryOne } from '@dispatch-foo/core';
import type { SqliteDatabase } from '@dispatch-foo/core';
import { chmodSync, existsSync } from 'node:fs';

import { MemoryError } from './errors.js';

export const MEMORY_DB_VERSION = 1;
// Raised only by a change older builds cannot read or write.
export const MEMORY_MIN_READER_VERSION = 1;
export type SearchMode = 'fts5' | 'like';

// memory.db and every personal <identity>.db share this schema; some tables
// stay empty in one of them. `seq` is the FTS rowid, stable across VACUUM.
const TABLES = `
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  refs TEXT NOT NULL, epic TEXT, applies_to TEXT NOT NULL, project_key TEXT,
  author TEXT NOT NULL, trust TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT,
  decay TEXT NOT NULL, pinned INTEGER NOT NULL, supersedes TEXT, superseded_by TEXT,
  origin TEXT UNIQUE, proposal_id TEXT, decided_by TEXT, decided_by_policy TEXT,
  rev INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, last_recalled_at TEXT, recall_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_state ON entries (scope, status, decay);
CREATE INDEX IF NOT EXISTS entries_hash ON entries (content_hash);
CREATE TABLE IF NOT EXISTS revisions (
  memory_id TEXT NOT NULL, rev INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
  by_addr TEXT NOT NULL, cause TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (memory_id, rev)
);
CREATE INDEX IF NOT EXISTS revisions_by ON revisions (by_addr, at);
CREATE TABLE IF NOT EXISTS recalls (
  memory_id TEXT NOT NULL, run_id TEXT NOT NULL, via TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (memory_id, run_id, via)
);
CREATE INDEX IF NOT EXISTS recalls_run ON recalls (run_id);
CREATE TABLE IF NOT EXISTS deleted_origins (
  origin TEXT PRIMARY KEY, entry_id TEXT NOT NULL, deleted_by TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, scope TEXT NOT NULL, target TEXT,
  base_rev INTEGER, content_json TEXT, reason TEXT, author TEXT NOT NULL,
  author_trust TEXT NOT NULL, operator TEXT, run_id TEXT, task_id TEXT,
  origin TEXT UNIQUE, content_hash TEXT, gate_id TEXT, state TEXT NOT NULL,
  matched_personal INTEGER NOT NULL, decided_by TEXT, decided_by_policy TEXT,
  decision_reason TEXT, result_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_state ON proposals (state, created_at);
CREATE TABLE IF NOT EXISTS exports (
  lineage TEXT NOT NULL, file TEXT NOT NULL, store TEXT NOT NULL, memory_id TEXT NOT NULL,
  rev INTEGER NOT NULL, parsed_hash TEXT NOT NULL, PRIMARY KEY (lineage, file)
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, memory_id TEXT,
  run_id TEXT, summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_at ON activity (at);
CREATE TABLE IF NOT EXISTS ingest_problems (
  id TEXT PRIMARY KEY, lineage TEXT NOT NULL, file TEXT NOT NULL, reason TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, content TEXT, at TEXT NOT NULL
);
`;

// Column names match the entries table: an external-content FTS5 table reads
// its values by name, and a mismatch breaks snippet().
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body, refs, content='entries', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, refs) VALUES (new.seq, new.title, new.body, new.refs);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, refs) VALUES ('delete', old.seq, old.title, old.body, old.refs);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE OF title, body, refs ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, refs) VALUES ('delete', old.seq, old.title, old.body, old.refs);
  INSERT INTO entries_fts(rowid, title, body, refs) VALUES (new.seq, new.title, new.body, new.refs);
END;
`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readMinReader(db: SqliteDatabase): number | null {
  const hasMeta = queryOne<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
  );
  if (hasMeta === undefined) return null;
  const row = queryOne<{ value: string }>(
    db,
    "SELECT value FROM meta WHERE key = 'min_reader_version'"
  );
  return row === undefined ? null : Number(row.value);
}

function setMeta(db: SqliteDatabase, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    key,
    value
  );
}

function disableFts(db: SqliteDatabase): 'like' {
  for (const trigger of ['entries_fts_ai', 'entries_fts_ad', 'entries_fts_au'])
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  setMeta(db, 'fts', '0');
  return 'like';
}

// Installs FTS5; rebuilds the index when a LIKE-mode build wrote rows without it.
function enableFts(db: SqliteDatabase): SearchMode {
  try {
    const current =
      queryOne<{ value: string }>(
        db,
        "SELECT value FROM meta WHERE key = 'fts'"
      )?.value === '1';
    db.exec(FTS);
    if (!current)
      db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')");
    setMeta(db, 'fts', '1');
    return 'fts5';
  } catch (err) {
    if (!/no such module: fts5/i.test(message(err))) throw err;
    return disableFts(db);
  }
}

function privateFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    try {
      chmodSync(file, 0o600);
    } catch {
      // A filesystem without POSIX modes is not a reason to refuse the store.
    }
  }
}

/** Opens (creating if needed) a memory database; refuses one that needs a newer reader. */
export function openMemoryDb(
  path: string,
  opts: { fts?: 'auto' | 'off' } = {}
): { db: SqliteDatabase; search: SearchMode } {
  let db: SqliteDatabase;
  try {
    db = openSqliteDb(path);
  } catch (err) {
    throw new MemoryError(
      'unavailable',
      `memory database ${path} will not open: ${message(err)}`,
      'store'
    );
  }
  try {
    // No synchronous wait: a locked write throws MemoryBusyError at once and
    // its caller retries asynchronously.
    db.exec('PRAGMA busy_timeout = 0');
    const minReader = readMinReader(db);
    if (minReader !== null && minReader > MEMORY_DB_VERSION) {
      throw new MemoryError(
        'unavailable',
        `memory unavailable (written by a newer Dispatch: needs reader ${minReader}, this build is ${MEMORY_DB_VERSION})`,
        'store'
      );
    }
    db.exec(TABLES);
    db.prepare(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('min_reader_version', ?)"
    ).run(String(MEMORY_MIN_READER_VERSION));
    if (dbVersion(db) < MEMORY_DB_VERSION)
      db.exec(`PRAGMA user_version = ${MEMORY_DB_VERSION}`);
    const search = opts.fts === 'off' ? disableFts(db) : enableFts(db);
    if (path !== ':memory:') privateFiles(path);
    return { db, search };
  } catch (err) {
    db.close();
    if (err instanceof MemoryError) throw err;
    throw new MemoryError(
      'unavailable',
      `memory database ${path} will not open: ${message(err)}`,
      'store'
    );
  }
}
