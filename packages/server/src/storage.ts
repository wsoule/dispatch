import type { TaskStoreBackend } from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
// THREE COPIES of this reader exist, the same way daemon-file discovery is
// duplicated (see packages/mcp/src/daemon.ts's note): this one, the CLI's in
// packages/cli/src/commands/task.ts, and the MCP server's in
// packages/mcp/src/daemon.ts. Keep them in step. They are separate because
// `@dispatch/server` is Bun-only and neither client can import it; the right
// long-term home is `@dispatch/core`, which all three already depend on.
// ---------------------------------------------------------------------------

const MARKER_FILE = 'storage.json';

function storageMarkerPath(rootDir: string): string {
  return join(rootDir, '.dispatch', MARKER_FILE);
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

/** Records the backend this project uses, for every other process to read. */
export function writeProjectBackend(
  rootDir: string,
  backend: TaskStoreBackend
): void {
  const path = storageMarkerPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ backend }, null, 2)}\n`);
}
