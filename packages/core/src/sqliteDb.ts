import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { DISPATCH_DIR } from './store.js';

/**
 * The slice of a synchronous SQLite driver everything above this module uses.
 *
 * It is declared here rather than imported from either driver so that no other
 * file names `node:sqlite` or `bun:sqlite` — sqliteTaskStore, sqliteRecords and
 * storeBackend all type their handle as `SqliteDatabase` and stay driver-blind.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqliteStatement {
  all(...params: SqlValue[]): unknown[];
  /** The matched row, or `undefined` when the query matched none. */
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

export interface SqliteDatabase {
  /**
   * Which driver module this handle was actually built from.
   *
   * It earns its place twice. A test can assert what `openDispatchDb` LOADED
   * rather than what `sqliteDriver()` would answer, and those are different
   * claims: the selector returning 'bun:sqlite' proves nothing about the
   * module the loader reached for. And it brands the interface, so a raw
   * `bun:sqlite` Database — which is otherwise structurally identical, but
   * whose `get()` answers a miss with null — can no longer be passed to
   * anything typed `SqliteDatabase`.
   */
  readonly driver: SqliteDriver;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/** A driver handle as its module hands it over, before adaptDriver brands it. */
type RawSqliteDatabase = Omit<SqliteDatabase, 'driver'>;

/** The module `openDispatchDb` loads its driver from on the current runtime. */
export type SqliteDriver = 'bun:sqlite' | 'node:sqlite';

/**
 * Picks a driver by runtime: Bun gets `bun:sqlite`, everything else
 * `node:sqlite`.
 *
 * Bun is not a runtime that happens to also have `node:sqlite` — it only
 * gained that module in 1.4.0, and the shipped `dispatch` CLI, the dispatchd
 * sidecar and the MCP server are single-file binaries compiled with the Bun
 * pinned in `.prototools`. Loading `node:sqlite` under Bun therefore worked on
 * a developer machine with a newer Bun on PATH and threw "No such built-in
 * module: node:sqlite" in every released binary, taking `dispatch migrate` and
 * every database-backed project with it. Keying off `process.versions.bun`
 * rather than off a probe means the choice does not silently drift back the
 * day the pinned Bun is bumped.
 */
export function sqliteDriver(): SqliteDriver {
  // `bun` is absent from Node's ProcessVersions, so this narrows rather than
  // assuming whichever @types package won the resolution.
  const versions = process.versions as { bun?: string };
  return versions.bun === undefined ? 'node:sqlite' : 'bun:sqlite';
}

/**
 * The driver is loaded on first use, not at module load.
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
 * and those are exactly the paths where a missing driver is worth an error.
 * `createRequire` rather than a dynamic `import()` so the loading stays
 * synchronous: making openDispatchDb async would ripple out through
 * initProjectStores and every store constructor for no benefit.
 */
type SqliteDatabaseCtor = new (path: string) => SqliteDatabase;
type RawSqliteDatabaseCtor = new (path: string) => RawSqliteDatabase;

let cachedCtor: SqliteDatabaseCtor | null = null;

function databaseCtor(): SqliteDatabaseCtor {
  if (cachedCtor !== null) return cachedCtor;
  const driver = sqliteDriver();
  try {
    const load = createRequire(import.meta.url);
    // `driver` IS the module specifier, so the module that gets loaded and the
    // brand that gets recorded cannot drift apart. Selecting with a literal on
    // each branch and passing the brand alongside would let a loader reach for
    // one module while reporting the other, which is exactly the failure the
    // brand exists to make visible.
    const loaded = load(driver) as {
      Database?: RawSqliteDatabaseCtor;
      DatabaseSync?: RawSqliteDatabaseCtor;
    };
    // bun:sqlite exports `Database` and no `DatabaseSync`; node:sqlite exports
    // `DatabaseSync` and no `Database`. That makes the export shape a
    // fingerprint of the module actually loaded, so the brand is read off the
    // module itself rather than copied from the selector that asked for it —
    // a loader that reached for the wrong one now reports the wrong one.
    const raw = loaded.Database ?? loaded.DatabaseSync;
    if (raw === undefined) {
      throw new Error(`${driver} exported no database constructor`);
    }
    const loadedDriver: SqliteDriver =
      loaded.Database === undefined ? 'node:sqlite' : 'bun:sqlite';
    cachedCtor = adaptDriver(loadedDriver, raw);
  } catch (err) {
    throw new Error(driverUnavailableMessage(driver, err as Error));
  }
  return cachedCtor;
}

// The advice differs per runtime, and getting it wrong is worse than useless:
// the pre-seam message told anyone hitting this under Bun to upgrade to Node
// 22.13, which would not have helped and pointed away from the real cause.
function driverUnavailableMessage(driver: SqliteDriver, err: Error): string {
  const preamble =
    `${driver} is unavailable in this runtime, so a database-backed ` +
    'dispatch project cannot be opened. ';
  const advice =
    driver === 'bun:sqlite'
      ? `Bun has shipped bun:sqlite since 1.0, so this is unexpected on Bun ${process.versions.bun ?? '(unknown)'} — please report it.`
      : 'It ships unflagged from Node 22.13; on an older 22.x, upgrade or pass --experimental-sqlite.';
  return `${preamble}${advice} Cause: ${err.message}`;
}

/**
 * Wraps a raw driver handle in the branded SqliteDatabase surface. Both
 * drivers go through here, so there is one adapter rather than one per module.
 *
 * It does exactly two things. It records which module the handle came from
 * (see SqliteDatabase.driver). And it normalizes `Statement.get()`, which is
 * the one behavioural difference that reaches callers: bun:sqlite answers a
 * miss with null where node:sqlite answers undefined, and `queryOne` is typed
 * `Row | undefined`. Left raw, a caller testing `row === undefined` would read
 * a missing task as a present one whose every column is null.
 *
 * What the two drivers were checked to agree on, and therefore what is
 * forwarded untouched: multi-statement `exec` (the DDL below is one script),
 * positional binding including null, `run()`'s `{ changes, lastInsertRowid }`,
 * and creating the database file when the path does not exist.
 *
 * KNOWN DIVERGENCE, deliberately not normalized here. On an INTEGER larger
 * than 2^53 node:sqlite throws "Value is too large to be represented as a
 * JavaScript number" while bun:sqlite silently rounds it. Matching them means
 * reading every integer as a BigInt (`safeIntegers`) and narrowing each one
 * back, which is a per-cell cost on every read of every row. No column in the
 * schema below can reach that magnitude — the INTEGER columns are 0/1 flags,
 * a line number, a round number and a per-run `seq` counter — so this is filed
 * as t-c14ff6 rather than paid for. Anyone adding a wide INTEGER column has to
 * revisit it: both drivers read the same file, so it is a hard error on the
 * Node-run CLI and a silently wrong number on the Bun-run desktop.
 */
function adaptDriver(
  driver: SqliteDriver,
  Raw: RawSqliteDatabaseCtor
): SqliteDatabaseCtor {
  return class AdaptedSqliteDatabase implements SqliteDatabase {
    readonly driver: SqliteDriver = driver;
    private readonly db: RawSqliteDatabase;

    constructor(path: string) {
      this.db = new Raw(path);
    }

    prepare(sql: string): SqliteStatement {
      const statement = this.db.prepare(sql);
      return {
        all: (...params) => statement.all(...params),
        get: (...params) => statement.get(...params) ?? undefined,
        run: (...params) => statement.run(...params),
      };
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    close(): void {
      this.db.close();
    }
  };
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
export function attachDispatchDb(dbPath: string): SqliteDatabase | null {
  if (dbPath !== ':memory:' && !existsSync(dbPath)) return null;
  return openDispatchDb(dbPath);
}

export function openDispatchDb(dbPath: string): SqliteDatabase {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const DatabaseClass = databaseCtor();
  const db = new DatabaseClass(dbPath);
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

// A driver types every result row as an opaque `unknown`, which never
// structurally overlaps a hand-written row interface, so reading one always
// needs a cast. These two wrappers hold the only two casts in the SQLite
// layer; every call site above them is plain typed code.
export function queryAll<Row>(
  db: SqliteDatabase,
  sql: string,
  params: SqlValue[] = []
): Row[] {
  return db.prepare(sql).all(...params) as unknown as Row[];
}

export function queryOne<Row>(
  db: SqliteDatabase,
  sql: string,
  params: SqlValue[] = []
): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

/** The schema version an already-open database was last written with. */
export function dbVersion(db: SqliteDatabase): number {
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
