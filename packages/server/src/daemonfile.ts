import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One JSON file per project root, so `dispatch serve`/`ui` invocations against
// the same rootDir find (or overwrite) the same daemon record without a
// central registry process.
//
// Three readers mirror this shape by hand and change with it: the CLI's
// commands/daemon.ts, the MCP's daemon.ts, and sidecar.rs's DaemonFileInfo.
export interface DaemonFileInfo {
  port: number;
  pid: number;
  rootDir: string;
  startedAt: string;
  // Request-tier token for the CLI and MCP, which have no other channel. The
  // decide-tier token stays out: this file is readable by anything as the user.
  agentToken: string;
}

// `DISPATCH_HOME` lets tests (and anything else) redirect daemon files away
// from the real home directory; production use always falls back to it. An
// empty string is treated the same as unset — kept in sync with this exact
// scheme's five other copies: packages/cli/src/commands/daemon.ts's
// `daemonHome()`, packages/mcp/src/daemon.ts's `daemonHome()`,
// apps/desktop/src-tauri/src/sidecar.rs's `daemon_home`, packages/server/
// src/orchestrator/paths.ts's `dispatchHome()`, and packages/server/
// src/sync/worktree.ts's `dispatchHome()` (those last two key run/worktree
// state instead of daemon files, but read the exact same env var with the
// exact same fallback rule); update all six together if this scheme ever
// changes.
function daemonHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

function daemonsDir(): string {
  return join(daemonHome(), '.dispatch', 'daemons');
}

// Daemon files are keyed by a short hash of the absolute rootDir rather than
// the path itself, so filenames stay short and filesystem-safe regardless of
// where a project lives.
export function daemonFileKey(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export function daemonFilePath(rootDir: string): string {
  return join(daemonsDir(), `${daemonFileKey(rootDir)}.json`);
}

// Mode 0600 because the file carries `agentToken`. As in core/credentials.ts,
// writeFileSync's `mode` is ignored on overwrite, so the chmod is explicit.
export function writeDaemonFile(info: DaemonFileInfo): void {
  mkdirSync(daemonsDir(), { recursive: true });
  const path = daemonFilePath(info.rootDir);
  writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem without POSIX modes is not a reason to fail the write.
  }
}

// A half-written or corrupt file reads as "no daemon" rather than throwing —
// same contract as the MCP package's own copy of this reader. A daemon killed
// mid-write (which is how a wedged one dies) is exactly how this file gets
// truncated, and the callers that then have to clean it up are the ones least
// able to handle an exception.
export function readDaemonFile(rootDir: string): DaemonFileInfo | null {
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonFileInfo;
  } catch {
    return null;
  }
}

// Removing on shutdown is what lets `dispatch ui` distinguish "no daemon" from
// "daemon crashed without cleanup" (the latter still leaves a stale file whose
// /api/health will simply fail to respond — a later slice's concern).
//
// Only the daemon the file currently names may remove it. A superseded daemon
// shutting down late — the file already rewritten by its replacement — used
// to delete the replacement's record, leaving a live daemon nobody could find
// (2026-09-08: a SIGTERM to an orphan erased the serving daemon's file).
// `ownerPid` defaults to this process; tests pass the pid they wrote.
export function removeDaemonFile(
  rootDir: string,
  ownerPid: number = process.pid
): void {
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) return;
  let current: DaemonFileInfo | null = null;
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as DaemonFileInfo;
  } catch {
    // Unparsable: nothing trustworthy names an owner, so clearing it is safe.
  }
  if (current !== null && current.pid !== ownerPid) return;
  rmSync(path);
}

// Whether `pid` is a live process. Signal 0 sends nothing; EPERM means the
// process exists under another user, which still counts as alive. Module-local
// on purpose: the CLI and MCP each carry their own copy, since neither can
// import from @dispatch/server (it is Bun-only).
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

// Throws when this root's daemon file names a live dispatchd that still
// answers — or merely stalls — on its port. Booting a second daemon anyway
// would run reconcileOnBoot against runs the first one still owns and
// force-fail all of them, which is exactly what happened on 2026-09-07 when
// a CLI health probe timed out against a busy daemon and spawned a
// replacement. A file whose pid is dead, or whose port refuses outright, is
// stale and does not block.
export async function assertRootNotServed(
  rootDir: string,
  healthTimeoutMs = 2000
): Promise<void> {
  const prior = readDaemonFile(rootDir);
  if (prior === null || prior.pid === process.pid || !pidAlive(prior.pid)) {
    return;
  }
  let served: boolean;
  try {
    const res = await fetch(`http://127.0.0.1:${prior.port}/api/health`, {
      signal: AbortSignal.timeout(healthTimeoutMs),
    });
    served = res.ok;
  } catch (err) {
    // Only a timeout means "alive but busy"; a refusal means nothing is there.
    served = (err as { name?: string }).name === 'TimeoutError';
  }
  if (!served) return;
  throw new Error(
    `another dispatchd (pid ${prior.pid}) is already serving ${rootDir} on port ${prior.port}; refusing to start a second one, which would force-fail the runs it has in flight. Stop it first (kill ${prior.pid}), or pass --replace to take over anyway.`
  );
}

// Whether this process is still the daemon clients will find for `rootDir`.
// Health reports it on every probe so a displaced daemon stops being visible
// only to `ps`: on 2026-09-07 three dispatchd processes served one project,
// each rewrote the daemon file last-writer-wins, and the two losers kept
// running agents nobody could reach. `assertRootNotServed` stops a new
// daemon from booting over a live one; this is the live one noticing after
// the fact.
type DaemonIdentity = 'ok' | 'displaced' | 'unregistered';

export interface DaemonIdentityCheck {
  identity: DaemonIdentity;
  // The human-readable form for GET /api/health's `problems`; null when
  // `identity` is 'ok'.
  problem: string | null;
}

// `claimed` is whether this daemon wrote a daemon file at boot. One started
// with `writeDaemonFile: false` never told clients to find it, so neither a
// missing file nor a file naming some other pid is news to it. The file is
// read fresh each call — it is one small JSON blob, and a stale answer here
// is the whole thing being guarded against. A file that exists but does not
// parse is not counted as either state: a replacement daemon may be
// mid-write, and removeDaemonFile already treats unparsable as ownerless.
export function checkDaemonIdentity(
  rootDir: string,
  claimed: boolean,
  ownPid: number = process.pid
): DaemonIdentityCheck {
  if (!claimed) return { identity: 'ok', problem: null };
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) {
    return {
      identity: 'unregistered',
      problem:
        "this project's daemon file is gone; clients will spawn a second daemon on their next call",
    };
  }
  let current: DaemonFileInfo;
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as DaemonFileInfo;
  } catch {
    return { identity: 'ok', problem: null };
  }
  if (current.pid === ownPid) return { identity: 'ok', problem: null };
  return {
    identity: 'displaced',
    problem: `another dispatchd (pid ${current.pid}, started ${current.startedAt}) has claimed this project's daemon file; this process (pid ${ownPid}) is no longer the one clients will find — stop one of them`,
  };
}
