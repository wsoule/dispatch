import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Daemon-file discovery — the fourth copy of this exact scheme.
//
// Mirrors the read side of packages/server/src/daemonfile.ts: same hash
// scheme, same `$DISPATCH_HOME`/homedir fallback (including treating an
// empty string as unset), same on-disk layout. `@dispatch/mcp` can't import
// `@dispatch/server` directly — same reason `@dispatch/cli` can't (server is
// Bun-only: bun:sqlite, Bun.serve) — so this is a small standalone reader
// with just what `run_list` needs: is a daemon running for this rootDir, and
// if so, on what port. The other four copies are packages/server/src/
// daemonfile.ts (the writer/source of truth), packages/cli/src/commands/
// daemon.ts, apps/desktop/src-tauri/src/sidecar.rs's `daemon_home`, and
// packages/server/src/orchestrator/paths.ts's `dispatchHome()` (that last
// one keys run/worktree state, not daemon files, but reads the identical env
// var) — keep all five in sync if this scheme ever changes. Unlike the CLI's
// copy, there is no fixture-based cross-check test here; a scheme change
// must be applied to this file by hand.
// ---------------------------------------------------------------------------

export interface DaemonFileInfo {
  port: number;
  pid: number;
  rootDir: string;
  startedAt: string;
  // Request tier, and the only credential this package ever holds. The app
  // token that decides scope requests is never written to disk, so there is
  // nothing here for an MCP tool to pick up.
  agentToken?: string;
}

function daemonHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Exported purely so this module's own tests can point a corrupt fixture at
// exactly the path `readDaemonFile` will look for, without duplicating the
// hash scheme a third time.
export function daemonFilePath(rootDir: string): string {
  const key = createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
  return join(daemonHome(), '.dispatch', 'daemons', `${key}.json`);
}

// Reads the daemon file for `rootDir`, or `null` if none exists — a missing
// file means no daemon has ever been started for this project (or it was
// cleanly stopped), not necessarily that one isn't running; `isDaemonHealthy`
// is what actually confirms liveness. M5: a *corrupt* file (a crash mid-write
// left truncated/invalid JSON behind) is treated exactly the same as a
// missing one — `run_list`'s caller already has a clean "no daemon" fallback
// for `null`, so there's no reason to let a JSON.parse throw escape and turn
// a stale file into a hard tool error instead of that same graceful path.
export function readDaemonFile(rootDir: string): DaemonFileInfo | null {
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonFileInfo;
  } catch {
    return null;
  }
}

// A daemon file can outlive the process it describes (a crash skips the
// on-stop cleanup in daemonfile.ts's `removeDaemonFile`), so a file existing
// is only ever a hint — this is the actual liveness check, matching the
// CLI's own `isHealthy`.
// A stale daemon file can name a port some OTHER process now holds — one that
// accepts the connection and then simply never answers. Without a deadline the
// probe inherits fetch's default (effectively none), so `dispatch task list`
// hangs indefinitely on a port that has nothing to do with dispatch. A health
// check is the one request that must never be the slow thing.
const HEALTH_TIMEOUT_MS = 2000;

export async function isDaemonHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // Includes the timeout abort: a port that accepts and stalls is exactly
    // as unhealthy as one that refuses.
    return false;
  }
}

// The request-tier bearer header every tool call carries. A daemon file
// written before token auth has no token to send; the daemon's own 401 then
// names the fix, so there is nothing better to say from here.
export function daemonAuth(daemon: DaemonFileInfo): Record<string, string> {
  const token = daemon.agentToken;
  return token === undefined || token === ''
    ? {}
    : { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Daemon proxying — how every task tool reaches this project's state.
//
// dispatchd is the single writer for a project (task t-c6dbd3): it holds the
// store open and every other process asks it rather than opening a second
// handle. These helpers are the small HTTP surface the tools in tools.ts use
// to do that, kept here beside daemon discovery so a tool body reads as one
// request rather than four lines of plumbing.
// ---------------------------------------------------------------------------

/** A reachable daemon, plus what its health probe already told us. */
export interface LiveDaemon {
  info: DaemonFileInfo;
  /** Files the daemon's last cache rebuild could not parse. */
  problems: string[];
}

/**
 * A daemon that exists, answers `/api/health`, AND carries a token we can
 * present — or null.
 *
 * The token check is not cosmetic. A daemon file written before two-tier auth
 * has no `agentToken`, and such a daemon still passes the health probe
 * (`/api/health` is the one open route). Routing to it on that basis committed
 * every following call to a daemon that would answer 401, with the local
 * fallback already skipped. Treating it as not-routable sends those calls
 * down the file path instead, which is exactly where they went before this
 * daemon existed.
 *
 * The health body is returned rather than discarded: the probe is a GET of
 * `/api/health`, which is also where the store's parse problems live, so
 * every caller that would otherwise fetch it a second time to fill in
 * `problems` gets them from the request already being made.
 */
export async function liveDaemon(rootDir: string): Promise<LiveDaemon | null> {
  const daemon = readDaemonFile(rootDir);
  if (daemon === null) return null;
  if (daemon.agentToken === undefined || daemon.agentToken === '') return null;
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/health`, {
      headers: daemonAuth(daemon),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      problems?: string[];
    };
    return { info: daemon, problems: body.problems ?? [] };
  } catch {
    return null;
  }
}

/**
 * Whether this project's state lives in a database only the daemon may open.
 *
 * This is the line between "the daemon is down, read the files yourself" and
 * "the daemon is down, and there is nothing you may safely do". On the file
 * backend a direct read is just a second reader of the same markdown, which
 * is what every tool here did before the daemon existed. On the database
 * backend it would be a second process opening a file another process holds a
 * write transaction over — precisely what single-writer exists to prevent —
 * so the tools refuse instead of falling back.
 *
 * Read from the project's recorded choice, NOT from whether a `dispatch.db`
 * happens to exist. A stray or half-created database file would otherwise
 * lock every tool out of a project whose tasks are really still in markdown,
 * with no way to say otherwise — existence is not ownership. The daemon
 * writes this marker when a project moves to the database; see
 * packages/server/src/storage.ts, which owns the format and explains why this
 * reader is duplicated rather than shared.
 */
export function daemonOwnsStore(rootDir: string): boolean {
  return readProjectBackend(rootDir) === 'sqlite';
}

/**
 * The backend a project recorded for itself, or null when it never recorded
 * one — which means markdown files, the pre-marker default. Corrupt or
 * unrecognized content reads as null for the same reason `readDaemonFile`
 * treats a truncated file as absent: a mangled file should degrade to the old
 * behaviour, never turn a tool call into a hard error.
 */
function readProjectBackend(rootDir: string): 'files' | 'sqlite' | null {
  const path = join(rootDir, '.dispatch', 'storage.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      backend?: unknown;
    };
    return parsed.backend === 'sqlite' || parsed.backend === 'files'
      ? parsed.backend
      : null;
  } catch {
    return null;
  }
}

/**
 * Thrown by `daemonRequest` when the daemon could not be reached at all — the
 * connection was refused, reset, or never established.
 *
 * Distinct from `DaemonHttpError`, and the distinction is what callers act on:
 * an HTTP error means a daemon answered and disagreed, so its wording is the
 * answer. This means nobody answered, which is recoverable — a file-backed
 * project can just read the files instead. Without a type for it, a daemon
 * that died between the health probe and the request surfaced to the agent as
 * a bare `TypeError: fetch failed`, which names neither the cause nor the fix.
 */
export class DaemonUnreachableError extends Error {
  constructor(
    readonly port: number,
    cause: string
  ) {
    super(
      `dispatchd stopped responding on port ${port} (${cause}). It answered a health check moments ago, so it has probably just exited — start it again with: dispatch serve`
    );
    this.name = 'DaemonUnreachableError';
  }
}

/** Thrown by `daemonRequest` when the daemon answered with a non-2xx status. */
export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'DaemonHttpError';
  }
}

/**
 * One authenticated request to a daemon, returning its parsed JSON body.
 *
 * Throws `DaemonHttpError` for a non-2xx (carrying the daemon's own `error`
 * text when it sent one, so a tool can surface the server's wording rather
 * than a bare status), and whatever fetch throws for a transport failure —
 * callers distinguish the two, because a 404 is an answer and a dropped
 * connection is not.
 */
export async function daemonRequest<T>(
  daemon: DaemonFileInfo,
  path: string,
  init?: RequestInit
): Promise<T> {
  // Merged through `Headers` rather than an object spread: `HeadersInit` is
  // allowed to be a `string[][]`, and spreading an array into an object
  // yields `{0: [...], 1: [...]}` — silently dropping every header a caller
  // passed that way. Same construction the CLI's own `request` uses.
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(daemonAuth(daemon))) {
    headers.set(key, value);
  }
  // A transport failure becomes `DaemonUnreachableError` rather than escaping
  // as fetch's own TypeError: there is a real gap between `liveDaemon`'s health
  // probe and this call, and a daemon that exits inside it is a normal event
  // (a restart, a crash, someone closing the app), not a programming error.
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      ...init,
      headers,
    });
  } catch (err) {
    throw new DaemonUnreachableError(daemon.port, (err as Error).message);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new DaemonHttpError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** A JSON-bodied request init, matching the CLI's own `jsonBody` helper. */
export function daemonJsonBody(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}
