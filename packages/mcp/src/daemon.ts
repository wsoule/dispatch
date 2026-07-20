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

interface DaemonFileInfo {
  port: number;
  pid: number;
  rootDir: string;
  startedAt: string;
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
export async function isDaemonHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
