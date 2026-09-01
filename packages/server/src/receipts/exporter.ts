import type {
  ActorContext,
  DispatchConfig,
  ReceiptsExport,
} from '@dispatch/core';
import { DEFAULT_RECEIPTS, materializeReceipts } from '@dispatch/core';
import type { ProjectStores } from '@dispatch/core';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { receiptsDir as defaultReceiptsDir } from '../orchestrator/paths.js';
import type { GitRunner } from '../sync/worktree.js';

// The git half of the receipt log. `materializeReceipts` in @dispatch/core owns
// the FORMAT — which files exist and what is in them; this owns the REPOSITORY
// — where the log lives, that it is a git repo at all, and when a commit
// happens.
//
// Deliberately not built on SyncWorktree, which is the board syncer's machinery
// for a worktree carved out of the USER'S repo. A receipt log has no upstream,
// no trunk to pin to, no remote to push to and nothing to pull: it is a
// standalone repository this daemon is the only writer of. That removes every
// part of SyncWorktree that can fail on the network or on someone else's
// history, which is why the exporter has no `blocked` state to report.

/** What one export pass did. */
export interface ReceiptsResult {
  // No `disabled` variant: a switched-off exporter produces no result at all
  // (ReceiptsScheduler returns null), rather than a result saying it did
  // nothing. BoardSyncer needs one because its `off` is a property of the
  // repository it found; this one's is a property of whether it ran.
  state: 'committed' | 'clean' | 'failed';
  dir: string;
  /** The commit this pass made, when it made one. */
  commit: string | null;
  /** Files changed and removed, for a UI that wants to say what moved. */
  changed: number;
  removed: number;
  /** Records the export could not read out of the database. */
  problems: number;
  detail: string;
}

/**
 * The file that marks a directory as a receipt log this daemon created.
 *
 * Load-bearing, not decorative: the export stages with `git add -A`, commits
 * with `--no-verify`, and PRUNES files whose records are gone. Pointed at a
 * directory that is already a git repository — a project checkout, someone's
 * notes, `receipts.dir: .` — that sequence would rewrite and commit over
 * somebody else's work every time a task changed. So the exporter refuses to
 * touch any directory that is not empty and does not carry this marker.
 */
const MARKER_FILE = '.dispatch-receipt-log';

interface ReceiptLogMarker {
  receiptLog: true;
  /** The project whose database this log belongs to. */
  project: string;
}

/**
 * Where this project's receipt log lives: `receipts.dir` from config.yml if
 * set, otherwise the default under DISPATCH_HOME.
 *
 * A relative override resolves against the project root rather than the
 * daemon's working directory, because config.yml is a file a person edits by
 * hand inside their repo and `receipts.dir: ../audit` should mean what it
 * looks like it means there.
 */
export function resolveReceiptsDir(
  rootDir: string,
  config: DispatchConfig
): string {
  const configured = config.receipts?.dir;
  if (configured === undefined) return defaultReceiptsDir(rootDir);
  return isAbsolute(configured) ? configured : resolve(rootDir, configured);
}

/** Whether the receipt log is switched on for this project. */
export function receiptsEnabled(config: DispatchConfig): boolean {
  return (config.receipts ?? DEFAULT_RECEIPTS).enabled;
}

// True when `child` sits anywhere under `parent`, both already resolved.
// Mirrors prWorktree.ts's helper of the same name and for the same reason:
// dispatch-owned state nested inside the project it describes is a footgun.
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export class ReceiptsExporter {
  constructor(
    private readonly stores: ProjectStores,
    private readonly actor: ActorContext,
    private readonly run: GitRunner
  ) {}

  /**
   * Writes the database out to `dir` and commits whatever changed.
   *
   * Materialize-then-commit, in that order, with git asked for the truth about
   * dirtiness rather than trusting the materializer's own `changed` list. The
   * two can legitimately disagree: a previous pass that wrote files and then
   * died before committing leaves a dirty tree that this pass would otherwise
   * decide was clean and skip forever.
   *
   * NEVER THROWS. Every caller is a timer callback or the boot path, and an
   * escaping rejection there takes the whole daemon down — Bun.spawnSync
   * throws outright when `git` is not on PATH, so even the git calls below are
   * inside the guard, not just the filesystem work.
   */
  exportOnce(dir: string): ReceiptsResult {
    try {
      return this.exportGuarded(dir);
    } catch (err) {
      return {
        state: 'failed',
        dir,
        commit: null,
        changed: 0,
        removed: 0,
        problems: 0,
        detail: (err as Error).message,
      };
    }
  }

  private exportGuarded(dir: string): ReceiptsResult {
    this.ensureRepo(dir);
    const materialized = materializeReceipts(this.stores, dir);
    const counts = {
      changed: materialized.changed.length,
      removed: materialized.removed.length,
      problems: materialized.problems.length,
    };
    for (const problem of materialized.problems) {
      console.error(`receipts: ${problem.source} — ${problem.detail}`);
    }
    const failed = (detail: string): ReceiptsResult => ({
      ...counts,
      state: 'failed',
      dir,
      commit: null,
      detail,
    });

    // `add -A` from the log root, so deletions are staged as deletions — a task
    // that left the database has to leave the log's HEAD too, or the log stops
    // being an accurate statement of what the project holds.
    const staged = this.run(dir, ['add', '-A']);
    if (staged.status !== 0) {
      return failed(`git add failed: ${staged.stderr.trim()}`);
    }
    const status = this.run(dir, ['status', '--porcelain']);
    if (status.status !== 0) {
      return failed(`git status failed: ${status.stderr.trim()}`);
    }
    if (status.stdout.trim() === '') {
      return {
        ...counts,
        state: 'clean',
        dir,
        commit: null,
        detail: 'no change since the last receipt',
      };
    }
    const committed = this.run(dir, [
      ...this.commitOptions(),
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      this.commitMessage(materialized),
    ]);
    if (committed.status !== 0) {
      return failed(`git commit failed: ${committed.stderr.trim()}`);
    }
    const head = this.run(dir, ['rev-parse', 'HEAD']);
    return {
      ...counts,
      state: 'committed',
      dir,
      commit: head.status === 0 ? head.stdout.trim() : null,
      detail: `${counts.changed} changed, ${counts.removed} removed`,
    };
  }

  /**
   * Identity and signing, passed per-command rather than written into the
   * repository's config.
   *
   * `user.name`/`user.email` have to come from somewhere: `git commit` refuses
   * outright when neither the global config nor the environment names an
   * author, and a daemon that cannot commit is a daemon with no audit trail.
   * Supplying them on every invocation rather than at `init` means they cannot
   * drift, cannot be lost if someone rewrites the log's `.git/config`, and need
   * no repair path — which a write-once-at-init approach silently does.
   *
   * Signing is forced off for a blunter reason: a machine-global
   * `commit.gpgsign = true` would make every export wait on a GPG agent that
   * may want a passphrase, and this runs on a 30-second timeout inside the
   * daemon. An audit log signed by nobody still says exactly what changed and
   * when; one that never commits says nothing at all.
   */
  private commitOptions(): string[] {
    return [
      '-c',
      `user.name=${this.actor.member.displayName}`,
      '-c',
      `user.email=${this.actor.member.email}`,
      '-c',
      'commit.gpgsign=false',
    ];
  }

  /**
   * Makes sure `dir` is a receipt log this daemon owns, creating it if the
   * directory is empty or absent, and refusing outright otherwise.
   *
   * The refusal is the point. `receipts.dir` is hand-edited in config.yml, and
   * the plausible mistakes — `.`, `..`, the project root, an existing notes
   * repo — all name a directory full of somebody's real work. Adopting one
   * would mean `git add -A` plus a pruning commit inside it on every task
   * change. So ownership is proven by a marker file this code wrote, never
   * inferred from the presence of `.git`.
   */
  private ensureRepo(dir: string): void {
    const project = resolve(this.stores.tasks.rootDir);
    const resolved = resolve(dir);
    // Nested inside the project is refused before anything is created: the
    // whole reason the log lives outside the repo is to keep ledger and
    // finding churn out of the project's own diffs, and a log inside the
    // repo would also be swept up by the project's own commits.
    if (resolved === project || isPathInside(project, resolved)) {
      throw new Error(
        `receipts.dir resolves to ${resolved}, inside the project itself ` +
          `(${project}) — refusing to write the audit trail into the repo it describes`
      );
    }
    const marker = join(dir, MARKER_FILE);
    if (existsSync(marker)) {
      this.verifyMarker(marker, resolved, project);
      // A log whose `.git` was deleted by hand is still ours to re-create;
      // the marker, not the repository, is what proves ownership.
      if (!existsSync(join(dir, '.git'))) this.init(dir);
      return;
    }
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(
        `refusing to use ${resolved} as a receipt log: it already has contents ` +
          `and no ${MARKER_FILE} marker, so it was not created by dispatch. ` +
          'Point receipts.dir at a new or empty directory.'
      );
    }
    mkdirSync(dir, { recursive: true });
    this.init(dir);
    writeFileSync(
      marker,
      `${JSON.stringify({ receiptLog: true, project } satisfies ReceiptLogMarker, null, 2)}\n`
    );
    // Nothing here is generated from something else in the tree, so an ignore
    // file would only ever hide a receipt. The one thing worth excluding is the
    // OS noise that would otherwise land in an audit commit.
    writeFileSync(join(dir, '.gitignore'), '.DS_Store\n');
  }

  // Refuses a log that belongs to a different project. Two projects sharing one
  // directory would each prune the other's task files and commit the deletion,
  // so a mismatch has to stop the export rather than be repaired silently. Only
  // reachable through an explicit `receipts.dir`; the default path is keyed by
  // a hash of the project root and cannot collide.
  private verifyMarker(
    marker: string,
    resolved: string,
    project: string
  ): void {
    let owner: string | null = null;
    try {
      const parsed = JSON.parse(
        readFileSync(marker, 'utf8')
      ) as Partial<ReceiptLogMarker>;
      owner = typeof parsed.project === 'string' ? parsed.project : null;
    } catch {
      // An unreadable marker is treated as one naming nobody: the directory is
      // still recognisably a dispatch log, so re-adopting it is safe.
      return;
    }
    if (owner !== null && owner !== project) {
      throw new Error(
        `${resolved} is the receipt log for ${owner}, not ${project} — ` +
          "refusing to overwrite another project's audit trail"
      );
    }
  }

  private init(dir: string): void {
    const created = this.run(dir, ['init']);
    if (created.status !== 0) {
      throw new Error(
        `could not create the receipt log at ${dir}: ${created.stderr.trim()}`
      );
    }
  }

  // Counts rather than names: a burst commit can touch a hundred task files,
  // and the log's own diff already says which. The subject stays scannable in
  // `git log --oneline`, which is how this history is actually read.
  private commitMessage(materialized: ReceiptsExport): string {
    const tally = materialized.tally;
    const summary =
      `${tally.tasks} task(s), ${tally.findings} finding(s), ` +
      `${tally.ledger} ledger entr(ies)`;
    return `receipts: ${summary}\n\n` + `Exported by ${this.actor.humanRef}.\n`;
  }
}
