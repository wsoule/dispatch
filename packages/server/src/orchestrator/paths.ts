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

// Where a run's diff snapshot (see Orchestrator.persistDiffSnapshot) lives —
// written right before the run's worktree is removed on every review path
// (local merge, discard, PR merge) so GET .../diff still has something to
// serve once the worktree that produced the diff is gone. Kept alongside the
// transcript in the same per-run-state directory rather than under the
// worktree itself, since the worktree is exactly what's about to disappear.
export function diffSnapshotPath(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.diff.json`);
}

// Where a run's review comments live — the line-level notes a human leaves on its diff. Kept
// per-run alongside the transcript and diff snapshot rather than in the worktree, for the same
// reason the snapshot is: every review path removes the worktree, and a comment has to outlive
// the code it was written against so it can travel back to the agent.
export function reviewCommentsPath(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.review.json`);
}

// Where the merge queue's persisted state (queued/active entries plus
// history) lives — see MergeQueue's persist()/hydrate() — so a daemon
// restart reloads the queue instead of silently dropping it, the same way
// diffSnapshotPath lets `diff()` survive a worktree's removal. Kept flat
// alongside the other per-run files under runsDir rather than its own
// subdirectory, since there is exactly one of these per project.
export function mergeQueuePath(rootDir: string): string {
  return join(runsDir(rootDir), 'merge-queue.json');
}

// A review run's own directory: the diff package it is handed and the findings
// JSON it writes back. Beside the transcript, so both outlive its worktree.
export function reviewDir(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.review`);
}

// The diff package file: commit list, stat and full diff, referenced by path
// from the prompt and never pasted into it.
export function reviewPackagePath(rootDir: string, runId: string): string {
  return join(reviewDir(rootDir, runId), 'diff-package.md');
}

// Where the review agent must write its structured findings.
export function reviewOutputPath(rootDir: string, runId: string): string {
  return join(reviewDir(rootDir, runId), 'findings.json');
}

export function worktreesDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'worktrees', rootHash(rootDir));
}

export function worktreePath(rootDir: string, runId: string): string {
  return join(worktreesDir(rootDir), runId);
}
