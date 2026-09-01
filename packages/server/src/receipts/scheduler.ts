import type { ActorContext, ProjectStores } from '@dispatch/core';
import { loadConfig } from '@dispatch/core';

import type { EventBus, ServerEvent } from '../events.js';
import type { GitRunner } from '../sync/worktree.js';
import type { ReceiptsResult } from './exporter.js';
import {
  receiptsEnabled,
  ReceiptsExporter,
  resolveReceiptsDir,
} from './exporter.js';

export interface ReceiptsSchedulerDeps {
  rootDir: string;
  stores: ProjectStores;
  actor: ActorContext;
  run: GitRunner;
  events: EventBus;
  /** Debounce for the export triggered by a record change. */
  debounceMs?: number;
  /**
   * How often to export even when no event arrived. Covers the records that
   * change without announcing it — see RECEIPT_EVENTS below. Defaults to
   * DEFAULT_SWEEP_MS; tests pass something large enough never to fire.
   */
  sweepMs?: number;
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
const RECEIPT_EVENTS: ReadonlySet<ServerEvent['type']> = new Set([
  'task.changed',
  'finding.changed',
  'ledger.changed',
]);

/** Whether this event should schedule an export. */
export function isReceiptEvent(event: ServerEvent): boolean {
  return RECEIPT_EVENTS.has(event.type);
}

/**
 * Turns record changes into debounced commits of the receipt log, exports once
 * at boot, and sweeps periodically for the records that change silently.
 *
 * The boot export is what makes the debounce safe to abandon on shutdown. An
 * export is a full materialization of the database, not an append, so a burst
 * lost to a kill -9 is not lost history — the next boot writes exactly the
 * same files and commits them. That is why this has no flush-on-stop path:
 * there is nothing a final flush could save that the next boot would not.
 */
export class ReceiptsScheduler {
  private readonly exporter: ReceiptsExporter;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private readonly sweep: ReturnType<typeof setInterval>;
  private stopped = false;
  private lastResultValue: ReceiptsResult | null = null;
  private lastExportedAtIso: string | null = null;

  constructor(private readonly deps: ReceiptsSchedulerDeps) {
    this.exporter = new ReceiptsExporter(deps.stores, deps.actor, deps.run);
    // Runs unconditionally; runOnce re-reads the config, so a project with
    // receipts off generates no export traffic despite the timer ticking, and
    // switching it back on takes effect without a restart.
    this.sweep = setInterval(() => {
      this.runOnce();
    }, deps.sweepMs ?? DEFAULT_SWEEP_MS);
  }

  /**
   * The export every boot performs before serving anything.
   *
   * Also the self-healing path: it reconciles a log left behind by a daemon
   * that was killed mid-burst, and it is what creates the repository the very
   * first time a project turns receipts on.
   */
  exportNow(): ReceiptsResult | null {
    return this.runOnce();
  }

  /**
   * A record changed: export shortly, coalescing a burst into one commit.
   *
   * Deliberately does NOT pre-check whether receipts are enabled. That check
   * costs a config read per event on a bus that is chatty, and it can only ever
   * agree with the one runOnce does after the debounce — where it has to happen
   * anyway, since the window is long enough for the config to change inside it.
   */
  notifyChanged(): void {
    if (this.stopped) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.runOnce();
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /**
   * One export pass, and the only path that ever runs one.
   *
   * Synchronous throughout, which is why there is no in-flight/rerun
   * bookkeeping here: this git repository has no remote, so every command is
   * local, and a single-threaded synchronous pass cannot be re-entered by a
   * timer that only fires between turns. BoardSyncScheduler needs that
   * machinery because its syncOnce awaits a push.
   */
  private runOnce(): ReceiptsResult | null {
    if (this.stopped) return null;
    // Read fresh every pass, from a file a person edits by hand, so turning
    // receipts off takes effect on the next change rather than at restart.
    let dir: string;
    try {
      const config = loadConfig(this.deps.rootDir);
      if (!receiptsEnabled(config)) return null;
      dir = resolveReceiptsDir(this.deps.rootDir, config);
    } catch (err) {
      // An unparseable config.yml must not take the daemon down from a timer
      // callback. Standing down is the safe read: it stops the export, and the
      // next pass after the file is fixed picks straight back up.
      console.error(
        `receipts: could not read config, export skipped: ${(err as Error).message}`
      );
      return null;
    }
    const result = this.exporter.exportOnce(dir);
    this.lastResultValue = result;
    this.lastExportedAtIso = new Date().toISOString();
    if (result.state === 'failed') {
      console.error(`receipts: export failed: ${result.detail}`);
    }
    this.deps.events.broadcast({ type: 'receipts.export', result });
    return result;
  }

  /** The most recent export's outcome, or `null` before the first one. */
  lastResult(): ReceiptsResult | null {
    return this.lastResultValue;
  }

  /** When the most recent export finished, or `null` before the first one. */
  lastExportedAt(): string | null {
    return this.lastExportedAtIso;
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    clearInterval(this.sweep);
  }
}
