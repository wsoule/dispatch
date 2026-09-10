import {
  attachDispatchDb,
  dispatchDbPath,
  openDispatchDb,
} from './sqliteDb.js';
import type { SqliteDatabase } from './sqliteDb.js';
import {
  SqliteEvidenceStore,
  SqliteFindingStore,
  SqliteLedgerStore,
} from './sqliteRecords.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import {
  ensureProjectConfig,
  ensureProjectGitignore,
  TaskStore,
} from './store.js';
import type { TaskStorePort } from './store.js';

// Which backend a project's state lives in. Chosen once, when the stores are
// opened, and never re-decided afterwards — everything downstream holds a
// `TaskStorePort` and cannot tell the difference.
export type TaskStoreBackend = 'files' | 'sqlite';

/**
 * The record stores that only exist on the database backend. On `files` these
 * are still the daemon's own JSONL sidecars (packages/server's FindingStore
 * and LedgerStore) plus each run's transcript, which core has no handle on —
 * hence `records: null` there rather than a second set of classes here.
 *
 * Also null on `sqlite` when the project has no database yet: there is nothing
 * to read and nowhere to write until something initializes one.
 */
export interface SqliteRecordStores {
  db: SqliteDatabase;
  findings: SqliteFindingStore;
  ledger: SqliteLedgerStore;
  evidence: SqliteEvidenceStore;
}

export interface ProjectStores {
  backend: TaskStoreBackend;
  tasks: TaskStorePort;
  records: SqliteRecordStores | null;
  /** Releases the database handle; a no-op on the file backend. */
  close(): void;
}

export interface OpenStoresOptions {
  rootDir: string;
  /** Defaults to `files`, which is what every caller does today. */
  backend?: TaskStoreBackend;
  /** Ignored unless `backend` is `sqlite`; defaults to `dispatchDbPath()`. */
  dbPath?: string;
}

/**
 * Attaches to a project's existing state without creating anything.
 *
 * This holds on both backends, and it has to: `new TaskStore(rootDir)` does
 * not create `.dispatch/tasks`, so attaching to a database must not bring
 * `dispatch.db` (plus its `-wal` and `-shm` companions) into a repo either.
 * A project with nothing there reads as uninitialized — `isInitialized()` is
 * false, lists come back empty, and writes refuse — rather than as an empty
 * project that quietly answers every question with a default.
 */
export function openProjectStores(options: OpenStoresOptions): ProjectStores {
  const { rootDir, backend = 'files' } = options;
  if (backend === 'files') {
    return {
      backend,
      tasks: new TaskStore(rootDir),
      records: null,
      close: () => {},
    };
  }
  const db = attachDispatchDb(options.dbPath ?? dispatchDbPath(rootDir));
  return sqliteStores(rootDir, db);
}

/** Creates a project's state if it is missing, then attaches to it. */
export function initProjectStores(options: OpenStoresOptions): ProjectStores {
  const { rootDir, backend = 'files' } = options;
  // Every path that creates a project passes through here — `dispatch init`,
  // `dispatch migrate`, and the desktop's add-project flow (server/src/bin.ts
  // `--init`) — which is why the ignore rules are written here rather than in
  // the CLI. A CLI-only implementation would leave every desktop-added
  // project free to commit its own database.
  //
  // Always the `files` rule set, even when initializing a database: opening a
  // database is not the same event as a project BECOMING database-backed.
  // `dispatch migrate` opens one and can still fail, and writing the
  // sqlite-only rules here left a project that is still file-backed ignoring
  // its own inbox and fix-loop state. The sqlite rules are added by
  // `writeProjectBackend`, which is the write that actually moves the project.
  ensureProjectGitignore(rootDir, 'files');
  if (backend === 'files') {
    TaskStore.init(rootDir);
    return openProjectStores(options);
  }
  ensureProjectConfig(rootDir);
  // Opening a database also applies the schema (every statement is CREATE ...
  // IF NOT EXISTS), so unlike the file backend there is no separate create
  // step for the tables themselves — only for config.yml, above.
  const db = openDispatchDb(options.dbPath ?? dispatchDbPath(rootDir));
  return sqliteStores(rootDir, db);
}

// Wraps a handle (or the absence of one) in the four stores that share it.
function sqliteStores(
  rootDir: string,
  db: SqliteDatabase | null
): ProjectStores {
  const tasks = new SqliteTaskStore(rootDir, db);
  if (db === null) {
    return { backend: 'sqlite', tasks, records: null, close: () => {} };
  }
  // Shutdown paths overlap — a caller closing on its own and a teardown
  // closing again — and the two drivers disagree about what that means:
  // node:sqlite throws "database is not open" on a second close() where
  // bun:sqlite ignores it. This swallows the repeat so the behaviour is the
  // same on both, rather than making every caller track it.
  let closed = false;
  return {
    backend: 'sqlite',
    tasks,
    records: {
      db,
      findings: new SqliteFindingStore(db),
      ledger: new SqliteLedgerStore(db),
      evidence: new SqliteEvidenceStore(db),
    },
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
