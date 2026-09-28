import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type ReviewTarget, reviewTargetSlug } from '../reviewTarget.js';

// `DISPATCH_HOME` lets tests (and anything else) redirect all dispatch state
// away from the real home directory; production use always falls back to it.
// Mirrors daemonfile.ts's `daemonHome()` — kept as a separate copy here
// rather than an import so the orchestrator module has no dependency on the
// daemon-file module, but the env var and fallback rule must stay identical.
// This is the fifth of six copies of this exact scheme: packages/server/src/
// daemonfile.ts (the writer/source of truth), packages/cli/src/commands/
// daemon.ts, packages/mcp/src/daemon.ts, and apps/desktop/src-tauri/src/
// sidecar.rs's `daemon_home` are four of the other five (all keying daemon
// files specifically, unlike this one); packages/server/src/sync/worktree.ts's
// `dispatchHome()` is the sixth, keying the board syncer's private worktree —
// update all six together if this scheme ever changes.
function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Runs and worktrees are keyed by a short hash of the project's absolute
// rootDir (same scheme as daemonfile.ts's `daemonFileKey`), so state for
// multiple dispatch projects never collides under one DISPATCH_HOME. Memory
// entries narrowed to one project carry the same key.
export function projectKeyOf(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export function runsDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'runs', projectKeyOf(rootDir));
}

export function transcriptPath(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.jsonl`);
}

// A live run's messaging token (mode 0600), read by its dispatch MCP server
// through DISPATCH_RUN_TOKEN_FILE and removed when the run ends.
export function runTokenPath(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.token`);
}

// The project's memory.db, beside messages.db in machine-local run-state.
export function memoryDbPath(rootDir: string): string {
  return join(runsDir(rootDir), 'memory.db');
}

// The Claude auto-memory export directories, one per session lineage.
export function claudeMemoryRoot(rootDir: string): string {
  return join(runsDir(rootDir), 'claude-memory');
}

// One lineage's export: `name` is a run lineage id or `o-<conversation>`.
export function claudeMemoryDir(rootDir: string, name: string): string {
  return join(claudeMemoryRoot(rootDir), name);
}

// Personal memory is cross-project, so it lives under DISPATCH_HOME, not a project's run-state.
export function personalMemoryDir(): string {
  return join(dispatchHome(), '.dispatch', 'memory');
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

// Where a finished run's requirement checklist (see
// judgments/landingChecklist.ts) lives — beside the diff snapshot it was
// judged from, so both outlive the worktree.
export function checklistPath(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.checklist.json`);
}

// Where a review target's comments live — the line-level notes a human
// leaves on its diff. Kept alongside the transcript and diff snapshot rather
// than in the worktree, for the same reason the snapshot is: every review
// path removes the worktree, and a comment has to outlive the code it was
// written against so it can travel back to the agent. A run target's slug is
// its bare run id, so this stays byte-identical to the path every review
// file was already written to.
export function reviewCommentsPath(
  rootDir: string,
  target: ReviewTarget
): string {
  return join(runsDir(rootDir), `${reviewTargetSlug(target)}.review.json`);
}

// What the last review pushed to GitHub for this target said — the sibling
// of the comment file above, so it survives a daemon restart the same way.
// Only a PR target is ever recorded, so moveAll's run-to-PR migration has
// no marker to strand.
export function reviewPushMarkerPath(
  rootDir: string,
  target: ReviewTarget
): string {
  return join(runsDir(rootDir), `${reviewTargetSlug(target)}.review-push.json`);
}

// Where a conversation lives, keyed by subject rather than by run: the Git page and a GitHub PR
// have no run to key on. The subject is hashed because it contains `:` and, for a worktree, `/`
// — neither of which belongs in a filename.
export function conversationPath(rootDir: string, subject: string): string {
  const key = createHash('sha256')
    .update(subject, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return join(runsDir(rootDir), `${key}.conversation.json`);
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

// Where EpicEngine's dispatch sessions live (see its persist()/hydrate()):
// the per-epic concurrency, ceilings and state a daemon restart re-arms
// instead of forgetting. Beside merge-queue.json for the same reason, and
// beside the run registry it derives spend from.
export function epicSessionsPath(rootDir: string): string {
  return join(runsDir(rootDir), 'epic-sessions.json');
}

// Where PrManager's epic-PR ledger lives: the PRs opened to land whole epic
// branches on the default base (epicId -> PR url), persisted so a daemon
// restart keeps polling them to merged instead of forgetting an epic mid-land.
// One file per project, same flat-alongside-the-runs placement as
// mergeQueuePath above it.
export function epicPrsPath(rootDir: string): string {
  return join(runsDir(rootDir), 'epic-prs.json');
}

// A review run's own directory: the diff package handed to it and the findings
// JSON it writes back, beside the transcript so both outlive its worktree.
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

// A verify run's own directory: its structured result and any artifacts it
// records, beside the transcript so both outlive the worktree.
export function verifyDir(rootDir: string, runId: string): string {
  return join(runsDir(rootDir), `${runId}.verify`);
}

// Where the verify agent must write its raw structured output.
export function verifyOutputPath(rootDir: string, runId: string): string {
  return join(verifyDir(rootDir, runId), 'output.json');
}

// The canonical result VerificationRunner writes after ingesting
// `verifyOutputPath`, so a malformed raw file is never read as usable.
export function verifyResultPath(rootDir: string, runId: string): string {
  return join(verifyDir(rootDir, runId), 'result.json');
}

export function worktreesDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'worktrees', projectKeyOf(rootDir));
}

export function worktreePath(rootDir: string, runId: string): string {
  return join(worktreesDir(rootDir), runId);
}

/**
 * Where a project's git receipt log lives by default — the audit trail the
 * daemon exports OUTSIDE the project repo, so ledger and finding churn stops
 * showing up in the project's own diffs.
 *
 * Keyed by the same `projectKeyOf` as runs and worktrees, but under `projects/`
 * rather than beside them: this is the one piece of per-project state a person
 * is expected to open, clone and read, so it gets a name that says what it
 * belongs to instead of sharing a directory with per-run scratch.
 *
 * `receipts.dir` in config.yml overrides this; resolveReceiptsDir owns that.
 */
export function receiptsDir(rootDir: string): string {
  return join(
    dispatchHome(),
    '.dispatch',
    'projects',
    projectKeyOf(rootDir),
    'receipts'
  );
}

/**
 * Where board sync keeps this replica's state: its identity, what it knows of
 * every synced field, and its clone of the sync branch (see
 * packages/server/src/boardSync). Machine-local by definition — it is this
 * replica's view — so under DISPATCH_HOME beside the receipt log, never in
 * the project.
 */
export function boardSyncDir(rootDir: string): string {
  return join(
    dispatchHome(),
    '.dispatch',
    'projects',
    projectKeyOf(rootDir),
    'sync'
  );
}

/**
 * Where issued teammate tokens live across a restart — as sha256 hashes, never
 * the tokens (see team/teammates.ts). Beside the receipt log under `projects/`, and
 * outside the repo for the obvious reason: a credential file must never be
 * one `git add -A` away from a commit.
 */
export function teamTokensPath(rootDir: string): string {
  return join(
    dispatchHome(),
    '.dispatch',
    'projects',
    projectKeyOf(rootDir),
    'team-tokens.json'
  );
}

// Where a project's terminal sessions keep their scrollback and index (see
// terminals.ts). Under `runs/` rather than beside the repo for the same reason
// transcripts are: this is per-machine scratch a person never diffs, and it
// has to outlive both the worktree a session was opened on and the daemon
// process that spawned it.
export function terminalsDir(rootDir: string): string {
  return join(runsDir(rootDir), 'terminals');
}

export function terminalScrollbackPath(rootDir: string, id: string): string {
  return join(terminalsDir(rootDir), `${id}.log`);
}

/**
 * Where a license key is installed (team/license.ts): one per machine rather
 * than per project, since a key belongs to whoever bought it, not to a
 * checkout.
 */
export function licenseKeyPath(): string {
  return join(dispatchHome(), '.dispatch', 'license.key');
}
