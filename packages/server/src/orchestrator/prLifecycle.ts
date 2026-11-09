import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

import type { EventBus } from '../events.js';
import { prLifecyclePath, runsDir } from './paths.js';
import { parsePrUrl, summarizeChecks } from './pr.js';
import type { RunMeta } from './types.js';
import { OrchestratorNotFoundError } from './types.js';

/**
 * Where one dispatch-opened PR stands on its way to landing.
 *
 * The first four are read straight off GitHub on every poll. The next four
 * are actions dispatch itself is taking (or waiting on a human for), so a
 * poll never moves a PR out of them. `merged` and `closed` are terminal.
 */
export type PrPhase =
  | 'checks-running'
  | 'ready'
  | 'changes-requested'
  | 'checks-failed'
  | 'rebasing'
  | 'resolving'
  | 'rereviewing'
  | 'needs-you'
  | 'merged'
  | 'closed';

// The phases a poll may not overwrite: each is set by the step that owns it
// (rebase, conflict resolve, re-review, a cap) and cleared by that step too.
// Only GitHub reporting the PR merged or closed moves a PR out of one.
const ACTION_PHASES: ReadonlySet<PrPhase> = new Set([
  'rebasing',
  'resolving',
  'rereviewing',
  'needs-you',
]);

export interface PrLifecycleState {
  runId: string;
  taskId: string;
  number: number;
  url: string;
  base: string;
  head: string;
  parentRunId: string | null;
  phase: PrPhase;
  autoMergeArmed: boolean;
  reviewedSha: string | null;
  headSha: string;
  rereviewRounds: number;
  resolveAttempts: number;
  reason: string | null;
  // Set while the last poll of this PR failed: the `gh` error now shown in
  // `reason`, plus the reason it replaced, so a successful poll can restore
  // it. Without this, a logged-out `gh` would erase a `needs-you` PR's
  // explanation for good.
  ghError: { message: string; displaced: string | null } | null;
  updatedAt: string;
}

/** The fields PrManager.pollOnce asks `gh pr view` for, as gh returns them. */
export interface PrView {
  state: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  reviewDecision: string | null;
  statusCheckRollup: unknown;
  autoMergeRequest: unknown;
}

/** The parts of a run the lifecycle needs to start a record for its PR,
 * looked up by run id when a PR has no record yet. */
export type PrLifecycleRun = Pick<
  RunMeta,
  'id' | 'taskId' | 'prUrl' | 'branch' | 'baseBranch'
>;

/**
 * Every tracked PR's lifecycle record, one JSON object keyed by run id in
 * `<runsDir>/pr-lifecycle.json`.
 *
 * It lives beside the milestone-PR ledger rather than in the project's
 * `.dispatch/` folder: it describes this machine's runs, which are
 * themselves machine-local. Each save rewrites the whole file through a
 * temp file and a rename, so a crash mid-write leaves the previous version
 * rather than half a file. That matters because the daemon reads this back
 * after a restart to resume whatever a PR was in the middle of.
 */
export class PrLifecycleStore {
  private cached: Map<string, PrLifecycleState> | null = null;

  constructor(private readonly rootDir: string) {}

  private read(): Map<string, PrLifecycleState> {
    if (this.cached !== null) return this.cached;
    const byRun = new Map<string, PrLifecycleState>();
    const path = prLifecyclePath(this.rootDir);
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
          string,
          PrLifecycleState
        >;
        for (const [runId, state] of Object.entries(raw)) {
          byRun.set(runId, state);
        }
      } catch (err) {
        // Move the unreadable file aside instead of letting the next save
        // overwrite it: the records in it are still recoverable by hand,
        // and the PRs themselves are re-observed on the next poll.
        const aside = `${path}.corrupt-${Date.now()}`;
        console.error(
          `dispatchd: unreadable PR lifecycle file, moved to ${aside}: ${(err as Error).message}`
        );
        try {
          renameSync(path, aside);
        } catch {
          // Nothing more to do; the save below will surface any real
          // filesystem problem.
        }
      }
    }
    this.cached = byRun;
    return byRun;
  }

  get(runId: string): PrLifecycleState | null {
    return this.read().get(runId) ?? null;
  }

  list(): PrLifecycleState[] {
    return [...this.read().values()];
  }

  save(state: PrLifecycleState): PrLifecycleState {
    const next = new Map(this.read());
    next.set(state.runId, state);
    const path = prLifecyclePath(this.rootDir);
    mkdirSync(runsDir(this.rootDir), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(next)));
    renameSync(tmp, path);
    // Only after the rename succeeded, so a failed write leaves the cache
    // agreeing with disk.
    this.cached = next;
    return state;
  }
}

// The conclusions summarizeChecks reports for a check that did not fail.
const NOT_FAILED: ReadonlySet<string> = new Set([
  'PENDING',
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
]);

// The GitHub-derived phase and its reason for an open PR. A requested change
// outranks checks: it needs a human's attention even if checks are green.
function openPhase(view: PrView): { phase: PrPhase; reason: string | null } {
  if (view.reviewDecision === 'CHANGES_REQUESTED') {
    return { phase: 'changes-requested', reason: 'changes requested' };
  }
  const checks = summarizeChecks(view.statusCheckRollup);
  if (checks.failed > 0) {
    const failing = checks.runs
      .filter((run) => !NOT_FAILED.has(run.conclusion))
      .map((run) => run.name);
    return { phase: 'checks-failed', reason: `failing: ${failing.join(', ')}` };
  }
  if (checks.pending > 0) return { phase: 'checks-running', reason: null };
  if (view.mergeable === 'CONFLICTING') {
    return { phase: 'ready', reason: 'conflicts with its base' };
  }
  return { phase: 'ready', reason: null };
}

// The fields a pr.changed event reports, or that a reader of the PRs view
// would see differ. updatedAt is excluded: it moves only when these do.
function sameState(a: PrLifecycleState, b: PrLifecycleState): boolean {
  return (
    a.phase === b.phase &&
    a.reason === b.reason &&
    a.autoMergeArmed === b.autoMergeArmed &&
    a.headSha === b.headSha &&
    a.base === b.base &&
    a.ghError?.message === b.ghError?.message
  );
}

/**
 * The per-PR state machine, fed by PrManager.pollOnce.
 *
 * This task only records what GitHub reports. Later landing-via-PRs tasks
 * hang their reactions off the same records: re-review on a head move,
 * rebase on a base move, fixes for requested changes. Every recorded
 * change is broadcast as `pr.changed`, so the PRs view and the task page
 * never have to guess.
 */
export class PrLifecycle {
  constructor(
    readonly store: PrLifecycleStore,
    private readonly events: EventBus,
    private readonly findRun: (runId: string) => PrLifecycleRun | null
  ) {}

  // The stored record for a run's PR, and the record to build the next one
  // from: the stored one, or a fresh seed from the run when there is none.
  private current(runId: string): {
    prev: PrLifecycleState | null;
    base: PrLifecycleState;
  } {
    const prev = this.store.get(runId);
    if (prev !== null) return { prev, base: prev };
    const run = this.findRun(runId);
    if (run === null) {
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    }
    return { prev, base: this.seed(run) };
  }

  // A first record for a PR dispatch has not tracked yet: one opened before
  // lifecycle tracking existed, or one whose first poll failed. Nothing is
  // known to have been reviewed, so reviewedSha starts null.
  private seed(run: PrLifecycleRun): PrLifecycleState {
    const url = run.prUrl ?? '';
    return {
      runId: run.id,
      taskId: run.taskId,
      number: parsePrUrl(url)?.number ?? 0,
      url,
      base: run.baseBranch,
      head: run.branch,
      parentRunId: null,
      phase: 'checks-running',
      autoMergeArmed: false,
      reviewedSha: null,
      headSha: '',
      rereviewRounds: 0,
      resolveAttempts: 0,
      reason: null,
      ghError: null,
      updatedAt: new Date().toISOString(),
    };
  }

  // Saves and broadcasts `next` if it differs from what was stored; a poll
  // that saw nothing new writes nothing and stays silent.
  private commit(
    prev: PrLifecycleState | null,
    next: PrLifecycleState
  ): PrLifecycleState {
    if (prev !== null && sameState(prev, next)) return prev;
    const saved = this.store.save({
      ...next,
      updatedAt: new Date().toISOString(),
    });
    this.events.broadcast({
      type: 'pr.changed',
      runId: saved.runId,
      taskId: saved.taskId,
      phase: saved.phase,
      reason: saved.reason,
    });
    return saved;
  }

  /** Folds one successful `gh pr view` of a run's PR into its record. */
  observe(runId: string, view: PrView): PrLifecycleState {
    const { prev, base } = this.current(runId);
    // A recovered poll gives back the reason the gh error had replaced.
    const priorReason =
      base.ghError !== null ? base.ghError.displaced : base.reason;
    let phase = base.phase;
    let reason = priorReason;
    if (view.state === 'MERGED') {
      phase = 'merged';
      reason = null;
    } else if (view.state === 'CLOSED') {
      phase = 'closed';
      reason = 'closed without merging';
    } else if (!ACTION_PHASES.has(base.phase) && !isTerminal(base.phase)) {
      ({ phase, reason } = openPhase(view));
    }
    return this.commit(prev, {
      ...base,
      phase,
      reason,
      ghError: null,
      headSha: view.headRefOid !== '' ? view.headRefOid : base.headSha,
      base: view.baseRefName !== '' ? view.baseRefName : base.base,
      autoMergeArmed:
        view.autoMergeRequest !== null && view.autoMergeRequest !== undefined,
    });
  }

  /**
   * Records that a run's PR could not be read this poll. The phase and
   * every other fact stay as they were, since nothing new is known; the
   * error goes into `reason` so the PR shows why it is not moving.
   */
  reportFailure(runId: string, message: string): PrLifecycleState {
    const { prev, base } = this.current(runId);
    const displaced =
      base.ghError !== null ? base.ghError.displaced : base.reason;
    return this.commit(prev, {
      ...base,
      reason: message,
      ghError: { message, displaced },
    });
  }
}

function isTerminal(phase: PrPhase): boolean {
  return phase === 'merged' || phase === 'closed';
}

/**
 * Reads a `gh pr view --json PR_LIFECYCLE_FIELDS` stdout into a PrView, or
 * null when it is not a JSON object. Missing fields default to "unknown"
 * values that observe() treats as no news.
 */
export function parsePrView(stdout: string): PrView | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const str = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  return {
    state: str(obj.state),
    headRefOid: str(obj.headRefOid),
    baseRefName: str(obj.baseRefName),
    mergeable: str(obj.mergeable),
    reviewDecision:
      typeof obj.reviewDecision === 'string' && obj.reviewDecision !== ''
        ? obj.reviewDecision
        : null,
    statusCheckRollup: obj.statusCheckRollup ?? [],
    autoMergeRequest: obj.autoMergeRequest ?? null,
  };
}
