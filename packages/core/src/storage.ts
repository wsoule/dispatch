import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DISPATCH_DIR, ensureProjectGitignore } from './store.js';
import type { TaskStoreBackend } from './storeBackend.js';

// ---------------------------------------------------------------------------
// Which backend a project's state lives in, recorded in the project itself.
//
// This has to be a property of the PROJECT, not of whoever happens to be
// running. dispatchd resolves its backend at boot; the CLI and the MCP tools
// need the same answer to decide whether they may read the store directly
// when no daemon is up. If the daemon took that from an environment variable
// and the clients guessed from the filesystem, the two could disagree — an
// auto-started daemon that inherited no `DISPATCH_STORE_BACKEND` would serve
// an empty `files` backend over a database-backed project, answering `task
// list` with nothing and writing `task create` to markdown beside the
// database nobody was reading. One file both sides read removes that.
//
// Absent means `files`. That keeps every project that predates this marker
// working untouched, and means the daemon never writes into a repo just
// because it booted there — only a project deliberately moved to the database
// gets a marker, written once when that move happens.
//
// This lives in `@dispatch/core` because three packages need it and only core
// is depended on by all of them: `@dispatch/server` re-exports these two
// (packages/server/src/storage.ts) and the CLI calls them directly. The MCP
// server still carries its own copy in packages/mcp/src/daemon.ts, alongside
// its copy of daemon-file discovery — keep the two readers in step, and fold
// that one in here when that module is next touched.
// ---------------------------------------------------------------------------

const MARKER_FILE = 'storage.json';

function storageMarkerPath(rootDir: string): string {
  return join(rootDir, DISPATCH_DIR, MARKER_FILE);
}

/**
 * The backend this project recorded, or null when it never recorded one
 * (which means `files`). A corrupt or unrecognized marker reads as null
 * rather than throwing: a hand-mangled file should degrade a project to its
 * pre-marker behaviour, not stop the daemon booting.
 */
export function readProjectBackend(rootDir: string): TaskStoreBackend | null {
  const path = storageMarkerPath(rootDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      backend?: unknown;
    };
    if (parsed.backend === 'sqlite' || parsed.backend === 'files') {
      return parsed.backend;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Records the backend this project uses, for every other process to read.
 *
 * This is the moment a project becomes database-backed, so it is also where
 * the backend-specific ignore rules land. Writing them when the database was
 * merely OPENED was wrong: `dispatch migrate` opens one before importing, and
 * an import that fails leaves the project file-backed — but already ignoring
 * the inbox and fix-loop state that, on the file backend, it is supposed to
 * commit.
 */
export function writeProjectBackend(
  rootDir: string,
  backend: TaskStoreBackend
): void {
  const path = storageMarkerPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ backend }, null, 2)}\n`);
  ensureProjectGitignore(rootDir, backend);
}
