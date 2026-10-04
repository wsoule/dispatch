import type {
  ActorContext,
  ProjectStores,
  ReceiptsScope,
} from '@dispatch/core';
import { DEFAULT_RECEIPTS_BRANCH, loadConfig } from '@dispatch/core';

import type { EventBus, ServerEvent } from '../events.js';
import type { PushTarget } from '../gitTarget.js';
import { resolvePushTarget } from '../gitTarget.js';
import type { AsyncGitRunner } from '../sync/worktree.js';
import { markBlockingSection } from '../watchdog.js';
import type { ReceiptsResult, ReceiptsStep } from './exporter.js';
import {
  receiptsEnabled,
  ReceiptsExporter,
  resolveReceiptsDir,
} from './exporter.js';

/** What the last push of the log to `receipts.remote` did. */
export interface ReceiptsPush {
  ok: boolean;
  at: string;
  detail: string;
}

export interface ReceiptsSchedulerDeps {
  rootDir: string;
  stores: ProjectStores;
  actor: ActorContext;
  /** Every git command the log runs: its commits and its pushes. */
  run: AsyncGitRunner;
  events: EventBus;
  /** Debounce for the export triggered by a record change. */
  debounceMs?: number;
  /**
   * How often to export even when no event arrived. Covers the records that
   * change without announcing it — see RECEIPT_EVENTS below. Defaults to
   * DEFAULT_SWEEP_MS; tests pass something large enough never to fire.
   */
  sweepMs?: number;
  /** Pauses before retrying a failed export, one per attempt; the last repeats. */
  retryMs?: readonly number[];
  /** Writers of more of the log (team docs), run after the core records. */
  steps?: readonly ReceiptsStep[];
}

// Matches BoardSyncScheduler's debounce, and for the same reason: long enough
// to coalesce an agent writing several records into one commit, short enough
// that a single edit reaches the log while someone is still looking at it.
const DEFAULT_DEBOUNCE_MS = 3_000;

// Five minutes. Long enough that a quiet project generates almost no traffic
// (an export that finds nothing changed commits nothing), short enough that
// evidence recorded during a long run is in the log before anyone goes looking
// for it.
const DEFAULT_SWEEP_MS = 300_000;

/**
 * Every event that means "a record the receipt log carries has changed".
 *
 * The log covers four record types and only three of them announce themselves:
 * `task.changed` for the board, `finding.changed` for review findings,
 * `ledger.changed` for decisions and hazards. Subscribing to `task.changed`
 * alone — which this did at first — meant a review that raised twenty findings
 * put nothing in the audit trail until somebody happened to edit an unrelated
 * task, which makes the log's own README ("committed on every change") false.
 *
 * Evidence has no event at all: it is written through the MCP tools straight
 * into the database. That is what the periodic sweep is for, and it is why the
 * sweep exists at all rather than being the "recover from a network outage"
 * timer BoardSyncScheduler needs.
 */
// Backoff between retries of a failed export.
const DEFAULT_RETRY_MS: readonly number[] = [10_000, 30_000, 60_000];

const RECEIPT_EVENTS: ReadonlySet<ServerEvent['type']> = new Set([
  'task.changed',
  'finding.changed',
  'ledger.changed',
]);

/** Whether this event should schedule an export; of memory, only team entries reach the log. */
export function isReceiptEvent(event: ServerEvent): boolean {
  if (event.type === 'memory.changed') return event.scope === 'team';
  return RECEIPT_EVENTS.has(event.type);
}

// What the next pass has to write: everything, or the tasks the events named
// plus, when a finding or ledger entry changed, the records.
interface PendingScope {
  full: boolean;
  taskIds: Set<string>;
  records: boolean;
}

function emptyScope(): PendingScope {
  return { full: false, taskIds: new Set(), records: false };
}

/**
 * Turns record changes into debounced commits of the receipt log, exports once
 * at boot, and sweeps periodically for the records that change silently.
 *
 * A change that names its tasks exports just those; anything else — the boot
 * pass, the sweep, a `task.changed` with no ids — is a full materialization,
 * which is what keeps the log self-healing: a burst lost to a kill -9, or a
 * scoped pass that failed, is caught up by the next full one. That is why this
 * has no flush-on-stop path: there is nothing a final flush could save that
 * the next boot would not.
 *
 * Passes run one at a time. Changes that arrive during one are held for the
 * next, so none is lost to a pass that had already read its scope.
 */
export class ReceiptsScheduler {
  private readonly exporter: ReceiptsExporter;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private readonly sweep: ReturnType<typeof setInterval>;
  private stopped = false;
  private pending: PendingScope = emptyScope();
  // The pass in flight (or the last one), so passes chain rather than overlap.
  private tail: Promise<unknown> = Promise.resolve();
  private queued = false;
  private lastResultValue: ReceiptsResult | null = null;
  private lastExportedAtIso: string | null = null;
  private pushing = false;
  private pushAgain = false;
  private lastPushValue: ReceiptsPush | null = null;
  // The log the last pass wrote to: a scoped pass into any other would leave
  // every task it does not name missing or stale there.
  private lastDir: string | null = null;
  // The pending retry after a failed export, and how many failed in a row.
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failedInRow = 0;

  constructor(private readonly deps: ReceiptsSchedulerDeps) {
    this.exporter = new ReceiptsExporter(
      deps.stores,
      deps.actor,
      deps.run,
      deps.steps
    );
    // Runs unconditionally; runPending re-reads the config, so a project with
    // receipts off generates no export traffic despite the timer ticking, and
    // switching it back on takes effect without a restart.
    this.sweep = setInterval(() => {
      this.pending.full = true;
      void this.enqueue();
    }, deps.sweepMs ?? DEFAULT_SWEEP_MS);
  }

  /**
   * A full export, now: the one every boot starts, and the self-healing path.
   * It reconciles a log left behind by a daemon that was killed mid-burst, and
   * it is what creates the repository the very first time a project turns
   * receipts on.
   */
  exportNow(): Promise<ReceiptsResult | null> {
    this.pending.full = true;
    return this.enqueue();
  }

  /**
   * A record changed: export shortly, coalescing a burst into one commit. A
   * `task.changed` that names its tasks narrows the pass to them; with no
   * event, or one naming nothing, the pass writes everything.
   *
   * Deliberately does NOT pre-check whether receipts are enabled. That check
   * costs a config read per event on a bus that is chatty, and it can only ever
   * agree with the one runPending does after the debounce — where it has to
   * happen anyway, since the window is long enough for the config to change
   * inside it.
   */
  notifyChanged(event?: ServerEvent): void {
    if (this.stopped) return;
    if (event?.type === 'task.changed' && event.ids !== undefined) {
      for (const id of event.ids) this.pending.taskIds.add(id);
    } else if (
      event?.type === 'finding.changed' ||
      event?.type === 'ledger.changed'
    ) {
      this.pending.records = true;
    } else {
      this.pending.full = true;
    }
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.enqueue();
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  // Chains a pass behind the one in flight. At most one waits: it takes the
  // scope as it stands when it starts, so later changes join it for free.
  private enqueue(): Promise<ReceiptsResult | null> {
    if (this.queued) {
      return this.tail.then(() => this.lastResultValue);
    }
    this.queued = true;
    const next = this.tail.then(() => this.runPending());
    // A pass that threw must not wedge every pass after it.
    this.tail = next.catch(() => null);
    return next;
  }

  // Takes what is pending and exports it; null when there was nothing to do
  // or receipts are off.
  private async runPending(): Promise<ReceiptsResult | null> {
    this.queued = false;
    if (this.stopped) return null;
    const pending = this.pending;
    if (!pending.full && pending.taskIds.size === 0 && !pending.records) {
      return null;
    }
    this.pending = emptyScope();
    // Read fresh every pass, from a file a person edits by hand, so turning
    // receipts off takes effect on the next change rather than at restart.
    let dir: string;
    try {
      const config = loadConfig(this.deps.rootDir);
      if (!receiptsEnabled(config)) {
        // What changed while off is not in the log: the next pass writes it all.
        this.pending.full = true;
        return null;
      }
      dir = resolveReceiptsDir(this.deps.rootDir, config);
    } catch (err) {
      // An unparseable config.yml must not take the daemon down from a timer
      // callback. Standing down is the safe read: it stops the export, and the
      // next pass after the file is fixed picks straight back up, in full.
      console.error(
        `receipts: could not read config, export skipped: ${(err as Error).message}`
      );
      this.pending.full = true;
      return null;
    }
    markBlockingSection('receipts export');
    const scope: ReceiptsScope =
      pending.full || dir !== this.lastDir
        ? {}
        : { taskIds: [...pending.taskIds], records: pending.records };
    const result = await this.exporter.exportOnce(
      dir,
      scope,
      () => this.stopped
    );
    this.lastDir = dir;
    if (this.stopped) return null;
    this.lastResultValue = result;
    this.lastExportedAtIso = new Date().toISOString();
    if (result.state === 'failed') {
      console.error(`receipts: export failed: ${result.detail}`);
      // Whatever this pass was meant to write, the next full one writes, and
      // it comes on a backoff rather than at the next sweep.
      this.pending.full = true;
      this.scheduleRetry();
    } else {
      this.failedInRow = 0;
    }
    this.deps.events.broadcast({ type: 'receipts.export', result });
    // A log that changed goes to its remote, if it has one. The boot pass
    // pushes even a clean log, so one committed while the remote was down is
    // sent the next time the daemon starts.
    if (result.state === 'committed' || this.lastPushValue === null) {
      void this.push(dir);
    }
    return result;
  }

  // Queues a full pass after a failed one: 10 s, 30 s, then every 60 s.
  private scheduleRetry(): void {
    if (this.stopped || this.retry !== null) return;
    const delays = this.deps.retryMs ?? DEFAULT_RETRY_MS;
    const delay = delays[Math.min(this.failedInRow, delays.length - 1)];
    this.failedInRow += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.enqueue();
    }, delay);
    this.retry.unref();
  }

  /**
   * Pushes the log to `receipts.remote` (a branch on one of the project's
   * remotes) or `receipts.repo` (a repository of its own), so the audit trail survives the
   * machine. Never forced: the log is one machine's own history, and a branch
   * two machines push to would have one overwrite the other — so a rejected
   * push is reported, with what to do, rather than pushed over.
   */
  private async push(dir: string): Promise<void> {
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    let target: PushTarget = {};
    let branch = DEFAULT_RECEIPTS_BRANCH;
    try {
      const receipts = loadConfig(this.deps.rootDir).receipts;
      target = { remote: receipts?.remote, repo: receipts?.repo };
      branch = receipts?.branch ?? DEFAULT_RECEIPTS_BRANCH;
    } catch {
      return;
    }
    if (target.remote === undefined && target.repo === undefined) return;
    this.pushing = true;
    try {
      const git = this.deps.run;
      const url = await resolvePushTarget(this.deps.rootDir, target, git);
      if (url === null) {
        this.lastPushValue = {
          ok: false,
          at: new Date().toISOString(),
          detail: `receipts.remote "${target.remote}" is not a remote of this project; add it, or point receipts.repo at a repository of its own`,
        };
        return;
      }
      const res = await git(dir, ['push', '-q', url, `HEAD:${branch}`]);
      const out = `${res.stdout}${res.stderr}`.trim();
      this.lastPushValue =
        res.status === 0
          ? {
              ok: true,
              at: new Date().toISOString(),
              detail: `${url} ${branch}`,
            }
          : {
              ok: false,
              at: new Date().toISOString(),
              detail: /rejected|non-fast-forward|fetch first/i.test(out)
                ? `${branch} on ${url} has history this log does not: another machine pushes its receipts there. Give each machine its own receipts.branch.`
                : out === ''
                  ? 'git push failed'
                  : out,
            };
      if (!this.lastPushValue.ok) {
        console.error(`receipts: push failed: ${this.lastPushValue.detail}`);
      }
    } finally {
      this.pushing = false;
      if (this.pushAgain) {
        this.pushAgain = false;
        void this.push(dir);
      }
    }
  }

  /** The most recent push's outcome, or `null` when none has run. */
  lastPush(): ReceiptsPush | null {
    return this.lastPushValue;
  }

  /** The most recent export's outcome, or `null` before the first one. */
  lastResult(): ReceiptsResult | null {
    return this.lastResultValue;
  }

  /** When the most recent export finished, or `null` before the first one. */
  lastExportedAt(): string | null {
    return this.lastExportedAtIso;
  }

  /**
   * Stops scheduling and resolves once a pass in flight has given up at its
   * next yield, so the caller can close the database behind it.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    clearInterval(this.sweep);
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    await this.tail;
  }
}
