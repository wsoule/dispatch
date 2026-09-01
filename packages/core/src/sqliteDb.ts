import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { DISPATCH_DIR } from './store.js';

/**
 * `node:sqlite` is loaded on first use, not at module load.
 *
 * It has to be. This module is reachable from `@dispatch/core`'s barrel, which
 * `@dispatch/cli` imports for every command — and `node:sqlite` only became
 * available unflagged in Node 22.13. On 22.0 through 22.12 a top-level
 * `import ... from 'node:sqlite'` throws ERR_UNKNOWN_BUILTIN_MODULE while the
 * module graph is being evaluated, so `dispatch task list` on a plain
 * file-backed project would die before its first line ran. The CLI's engines
 * field permits those versions (`node: >=22`), so this is a real matrix, not a
 * hypothetical one.
 *
 * Deferring it means only the paths that actually open a database pay for it,
 * and those are exactly the paths where a missing `node:sqlite` is worth an
 * error. `createRequire` rather than a dynamic `import()` so the loading stays
 * synchronous: making openDispatchDb async would ripple out through
 * initProjectStores and every store constructor for no benefit.
 */
type DatabaseSyncCtor = new (path: string) => DatabaseSync;

let cachedCtor: DatabaseSyncCtor | null = null;

function databaseSyncCtor(): DatabaseSyncCtor {
  if (cachedCtor !== null) return cachedCtor;
  try {
    const nodeRequire = createRequire(import.meta.url);
    const loaded = nodeRequire('node:sqlite') as {
      DatabaseSync: DatabaseSyncCtor;
    };
    cachedCtor = loaded.DatabaseSync;
  } catch (err) {
    throw new Error(
      'node:sqlite is unavailable in this runtime, so a database-backed ' +
        'dispatch project cannot be opened. It ships unflagged from Node ' +
        `22.13; on an older 22.x, upgrade or pass --experimental-sqlite. Cause: ${(err as Error).message}`
    );
  }
  return cachedCtor;
}

// The single database a daemon-owned project keeps its orchestration state
// in: tasks (epics are tasks with `kind = 'epic'`), review findings, ledger
// entries (decisions are ledger rows with `kind = 'decision'`), and the
// command/mutation evidence a run records. Everything the markdown task files
// and the `.dispatch/*.jsonl` sidecars hold today, in one place a writer can
// hold a transaction over.
//
// This module owns the schema and nothing else; the accessors live in
// sqliteTaskStore.ts and sqliteRecords.ts.

/**
 * Bumped whenever the DDL below changes in a way an existing database has to
 * be migrated through. Stored in SQLite's own `user_version` pragma, so the
 * schema carries its version without a table of its own.
 */
export const DISPATCH_DB_VERSION = 1;

/**
 * Where a project's database lives by default.
 *
 * Note this is inside the project repo, which is the convenient default for
 * a single-project daemon but not the end state: the storage-spine plan moves
 * the database (and the git receipt log beside it) out to
 * `~/.dispatch/projects/<id>/` so orchestration state stops churning project
 * diffs. Every caller passes an explicit path, so moving it is a one-line
 * change at the call site rather than a change here.
 */
export function dispatchDbPath(rootDir: string): string {
  return join(rootDir, DISPATCH_DIR, 'dispatch.db');
}

// Arrays (blocked-by, labels, writes, applies-to) are stored as JSON text
// rather than child tables: nothing queries into them, and keeping them in one
// column means a row round-trips to a TaskMeta without a second read.
//
// Absent-vs-false is carried by NULL: `fix_loop` and `archived_at` are keys a
// task file only grows once they are set, and TaskMeta models them as optional
// rather than nullable, so NULL here means "no key" and 0 means "explicitly
// off". `self_review` and `exercised` are always present, so they are plain
// 0/1.
const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  parent       TEXT,
  milestone    TEXT,
  blocked_by   TEXT NOT NULL,
  labels       TEXT NOT NULL,
  priority     TEXT NOT NULL,
  assignee     TEXT NOT NULL,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL,
  external     TEXT,
  self_review  INTEGER NOT NULL,
  fix_loop     INTEGER,
  writes       TEXT NOT NULL,
  risk         TEXT NOT NULL,
  model        TEXT,
  archived_at  TEXT,
  exercised    INTEGER NOT NULL,
  derived_from TEXT,
  slug         TEXT NOT NULL,
  body         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_kind_idx ON tasks (kind);
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent);
CREATE INDEX IF NOT EXISTS tasks_order_idx ON tasks (created, id);

CREATE TABLE IF NOT EXISTS findings (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  run_id         TEXT,
  severity       TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,
  file           TEXT,
  line           INTEGER,
  files          TEXT,
  ruling         TEXT,
  recommendation TEXT,
  round          INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  raised_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_task_idx ON findings (task_id);
CREATE INDEX IF NOT EXISTS findings_verdict_idx ON findings (verdict);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             TEXT PRIMARY KEY,
  epic_id        TEXT,
  source_task_id TEXT,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,
  applies_to     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  authored_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_epic_idx ON ledger_entries (epic_id);

CREATE TABLE IF NOT EXISTS evidence (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  command     TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  summary     TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS mutations (
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  guard        TEXT NOT NULL,
  file         TEXT NOT NULL,
  tests_failed INTEGER NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`;

/**
 * Opens (creating if needed) a dispatch database and brings its schema up to
 * date. Callers hold the returned handle for the life of the process; the
 * store classes below each take one rather than opening their own, so all of
 * them see the same transaction and the same WAL.
 *
 * A database stamped with a version this build does not understand is
 * rejected rather than opened; see the check below.
 *
 * There are deliberately no foreign keys between findings/ledger rows and
 * tasks: today's JSONL sidecars keep a finding after its task file is deleted,
 * and a schema that silently cascaded those away would lose review history the
 * file-backed store still has.
 */
/**
 * Opens a dispatch database only if one is already there, returning null when
 * it is not. This is the read-side counterpart of openDispatchDb: attaching to
 * a project must not bring a database (plus its -wal and -shm files) into
 * existence, the same way constructing a `TaskStore` does not create
 * `.dispatch/tasks`. Without it, listing tasks in a directory that never opted
 * in would litter the repo and make every project look initialized.
 */
export function attachDispatchDb(dbPath: string): DatabaseSync | null {
  if (dbPath !== ':memory:' && !existsSync(dbPath)) return null;
  return openDispatchDb(dbPath);
}

export function openDispatchDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const DatabaseSyncClass = databaseSyncCtor();
  const db = new DatabaseSyncClass(dbPath);
  // WAL lets the desktop read while the daemon writes; NORMAL syncing is the
  // usual pairing — a crash can lose the last commit, and orchestration state
  // is re-derivable, but corruption is not on the table.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // A database a newer Dispatch wrote may hold columns and tables this build
  // knows nothing about. Applying the older DDL over it and stamping
  // user_version back down would leave it looking current while this build
  // wrote rows the newer schema does not accept, so refuse to open it at all.
  const existing = dbVersion(db);
  if (existing > DISPATCH_DB_VERSION) {
    db.close();
    throw new Error(
      `dispatch database at ${dbPath} was written by a newer schema (version ${existing}, this build understands ${DISPATCH_DB_VERSION})`
    );
  }
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${DISPATCH_DB_VERSION}`);
  return db;
}

// node:sqlite types every result row as `Record<string, SQLOutputValue>`,
// which never structurally overlaps a hand-written row interface, so reading
// one always needs a cast. These two wrappers hold the only two casts in the
// SQLite layer; every call site above them is plain typed code.
export function queryAll<Row>(
  db: DatabaseSync,
  sql: string,
  params: SQLInputValue[] = []
): Row[] {
  return db.prepare(sql).all(...params) as unknown as Row[];
}

export function queryOne<Row>(
  db: DatabaseSync,
  sql: string,
  params: SQLInputValue[] = []
): Row | undefined {
  return db.prepare(sql).get(...params) as unknown as Row | undefined;
}

/** The schema version an already-open database was last written with. */
export function dbVersion(db: DatabaseSync): number {
  return (
    queryOne<{ user_version: number }>(db, 'PRAGMA user_version')
      ?.user_version ?? 0
  );
}

/**
 * A row this build cannot read: a JSON column that will not parse, an enum
 * column holding a value outside its set. Distinct from "no such row" so a
 * caller can tell a missing task from a damaged one.
 *
 * Damaged rows are surfaced, never coerced. A `blocked_by` that read as `[]`
 * would silently un-block a task; a `writes` that read as `[]` would erase a
 * task's declared write scope; an `applies_to` that read as `[]` would
 * broadcast a ledger entry aimed at one task to every task under its epic.
 * The file backend throws a TaskParseError in exactly these situations, and
 * listSafe() is the seam that turns one bad record into a skip rather than a
 * failed scan.
 */
export class SqliteRowError extends Error {
  constructor(
    readonly table: string,
    readonly rowId: string,
    readonly column: string,
    detail: string
  ) {
    super(`${table} row ${rowId}: ${column} ${detail}`);
    this.name = 'SqliteRowError';
  }
}

/** Reads a JSON string-array column, throwing rather than defaulting to []. */
export function parseStringArray(
  value: unknown,
  table: string,
  rowId: string,
  column: string
): string[] {
  if (typeof value !== 'string') {
    throw new SqliteRowError(table, rowId, column, 'is not text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SqliteRowError(
      table,
      rowId,
      column,
      `is not valid JSON: ${value.slice(0, 80)}`
    );
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new SqliteRowError(
      table,
      rowId,
      column,
      'is not an array of strings'
    );
  }
  return parsed as string[];
}

/** The inverse of parseStringArray, for the write side of the same columns. */
export function serializeStringArray(value: readonly string[]): string {
  return JSON.stringify(value);
}

/**
 * Reads a closed-set text column. The blind `as` cast this replaces let a
 * damaged row hand a caller a `kind` or `severity` no downstream switch has a
 * branch for, which surfaces far from the row that caused it.
 *
 * Open-ended columns are deliberately not routed through here: `status` is
 * whatever the project's config.yml lists, and `assignee` is a serialized
 * ActorRef, so neither has a set to check against.
 */
export function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  table: string,
  rowId: string,
  column: string
): T {
  if (
    typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw new SqliteRowError(
    table,
    rowId,
    column,
    `is not one of ${allowed.join(', ')}: ${String(value).slice(0, 80)}`
  );
}
