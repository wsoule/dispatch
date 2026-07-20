import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `DISPATCH_HOME` lets tests (and anything else) redirect all dispatch state
// away from the real home directory; production use always falls back to it.
// Mirrors daemonfile.ts's `daemonHome()` — kept as a separate copy here
// rather than an import so the orchestrator module has no dependency on the
// daemon-file module, but the env var and fallback rule must stay identical.
// This is the fifth copy of this exact scheme: packages/server/src/
// daemonfile.ts (the writer/source of truth), packages/cli/src/commands/
// daemon.ts, packages/mcp/src/daemon.ts, and apps/desktop/src-tauri/src/
// sidecar.rs's `daemon_home` are the other four (all keying daemon files
// specifically, unlike this one) — update all five together if this scheme
// ever changes.
function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Runs and worktrees are keyed by a short hash of the project's absolute
// rootDir (same scheme as daemonfile.ts's `daemonFileKey`), so state for
// multiple dispatch projects never collides under one DISPATCH_HOME.
export function rootHash(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export function runsDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'runs', rootHash(rootDir));
}

export function transcriptPath(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.jsonl`);
}

export function worktreesDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'worktrees', rootHash(rootDir));
}

export function worktreePath(rootDir: string, runId: string): string {
  return join(worktreesDir(rootDir), runId);
}
