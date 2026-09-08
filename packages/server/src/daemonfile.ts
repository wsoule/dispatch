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
// Only the daemon named in the file may remove it. A daemon whose event loop
// was stalled runs its SIGTERM handler late — possibly after the app has
// already started a replacement that wrote its own file to this path — and
// deleting "whatever is here" then erases the healthy successor's record, so
// every client concludes there is no daemon at all (2026-08-23). A file that
// cannot be parsed has no owner and is removed as the stale garbage it is.
export function removeDaemonFile(
  rootDir: string,
  ownerPid: number = process.pid
): void {
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) return;
  const current = readDaemonFile(rootDir);
  if (current !== null && current.pid !== ownerPid) return;
  rmSync(path);
}
