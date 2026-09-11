import type {
  WatchdogCommand,
  WatchdogReport,
  WatchdogWorkerInit,
} from './watchdogShared.js';
import {
  HEARTBEAT_OFFSET,
  LABEL_BYTES,
  LABEL_LENGTH_OFFSET,
  LABEL_OFFSET,
  SHARED_BUFFER_BYTES,
} from './watchdogShared.js';

/**
 * One event-loop stall the watchdog observed, delivered to `onStall` once the
 * loop is running again (a stalled loop cannot run callbacks — the worker's
 * stderr line is the live record; this is the after-the-fact one).
 */
export interface StallReport {
  /** How long the main thread went without a heartbeat. */
  stalledMs: number;
  /** The last section marked before the stall began — see `mark`. */
  section: string;
}

export interface EventLoopWatchdogOptions {
  /** A gap between heartbeats longer than this is a stall. */
  thresholdMs?: number;
  /** How often the main thread writes its heartbeat. */
  heartbeatMs?: number;
  /** How often the worker compares the heartbeat against the clock. */
  checkMs?: number;
  /** Delivered after a stall ends. The worker logs to stderr regardless. */
  onStall?: (report: StallReport) => void;
  /**
   * Keeps the worker's stderr lines out of the log; `onStall` still fires.
   * For tests that stall the loop on purpose — a real daemon never sets it.
   */
  quiet?: boolean;
}

/**
 * Where a watchdog is in its life. `armed` is the only state in which a
 * stall would be reported; `failed` means the worker never came up — in a
 * compiled daemon, that the worker module was not a build entrypoint (see
 * apps/desktop/scripts/build-sidecars.ts). Surfaced at GET /api/health.
 */
export type WatchdogStatus =
  | 'idle'
  | 'starting'
  | 'armed'
  | 'failed'
  | 'stopped';

const DEFAULT_THRESHOLD_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 250;
const DEFAULT_CHECK_MS = 1_000;

/**
 * Detects a blocked daemon event loop from a worker thread and says what the
 * main thread was doing when it blocked.
 *
 * The 2026-08-23 incident: dispatchd sat unresponsive for 89 minutes, then
 * again for ten hours, while alive. The only record of what it was doing was a
 * stripped-binary `sample` with no symbols. A stalled main thread cannot log
 * anything itself, so this runs on a Worker that shares a SharedArrayBuffer
 * with the main thread: the main thread stamps a heartbeat every
 * `heartbeatMs` and writes a short label (`mark`) before each section that
 * can block — a synchronous git spawn, a timer tick, a request. The worker
 * wakes on its own timer, and when the heartbeat goes stale it writes
 * "event loop stalled Ns in <label>" to stderr — the daemon log — while the
 * stall is still happening, then repeats at intervals until it ends.
 *
 * The label is deliberately the *last section entered*, not a stack: a
 * worker cannot read another thread's JS stack, and every blocking primitive
 * in this daemon is a call site that can name itself in one line.
 */
export class EventLoopWatchdog {
  private readonly buffer = new SharedArrayBuffer(SHARED_BUFFER_BYTES);
  private readonly heartbeat = new BigInt64Array(
    this.buffer,
    HEARTBEAT_OFFSET,
    1
  );
  private readonly labelLength = new Int32Array(
    this.buffer,
    LABEL_LENGTH_OFFSET,
    1
  );
  private readonly label = new Uint8Array(
    this.buffer,
    LABEL_OFFSET,
    LABEL_BYTES
  );
  private readonly encoder = new TextEncoder();
  private readonly thresholdMs: number;
  private readonly heartbeatMs: number;
  private readonly checkMs: number;
  private readonly onStall: ((report: StallReport) => void) | undefined;
  private readonly quiet: boolean;
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lifecycle: WatchdogStatus = 'idle';

  constructor(opts: EventLoopWatchdogOptions = {}) {
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.checkMs = opts.checkMs ?? DEFAULT_CHECK_MS;
    this.onStall = opts.onStall;
    this.quiet = opts.quiet ?? false;
  }

  start(): void {
    if (this.worker !== null) return;
    this.beat();
    // Both unref'd: a watchdog must never be the thing keeping a daemon (or a
    // test process) alive after everything else has stopped.
    this.timer = setInterval(() => this.beat(), this.heartbeatMs);
    this.timer.unref();
    const worker = new Worker(workerUrl());
    worker.unref();
    worker.addEventListener('message', (event: MessageEvent) => {
      // A report in flight when stop() ran belongs to a watchdog that no
      // longer exists; dropping it keeps a stopped server silent.
      if (this.worker !== worker) return;
      const report = event.data as WatchdogReport;
      if (report.type === 'ready') {
        this.lifecycle = 'armed';
      } else if (report.type === 'stall-ended') {
        this.onStall?.({
          stalledMs: report.stalledMs,
          section: report.section,
        });
      }
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      console.error(`dispatchd: event loop watchdog stopped: ${event.message}`);
      // The worker is gone (a failed load is the common case: its module was
      // not compiled into the binary). Forget it so stop() does not post to a
      // dead thread and mark() stops writing labels nobody reads.
      if (this.worker === worker) {
        this.worker = null;
        this.lifecycle = 'failed';
      }
    });
    const init: WatchdogWorkerInit = {
      type: 'start',
      buffer: this.buffer,
      thresholdMs: this.thresholdMs,
      checkMs: this.checkMs,
      quiet: this.quiet,
    };
    worker.postMessage(init);
    this.worker = worker;
    this.lifecycle = 'starting';
    setActiveWatchdog(this);
  }

  status(): WatchdogStatus {
    return this.lifecycle;
  }

  /**
   * Stops the heartbeat, terminates the worker and releases the marking seam.
   * Idempotent, and safe to call on a watchdog that never started. The worker
   * is asked to stop its own timer before being terminated: terminate() is
   * not instantaneous, and a worker mid-tick with a heartbeat that has just
   * stopped is exactly the shape it would otherwise report as a stall.
   */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      const command: WatchdogCommand = { type: 'stop' };
      worker.postMessage(command);
      worker.terminate();
    }
    this.lifecycle = 'stopped';
    if (activeWatchdog === this) setActiveWatchdog(null);
  }

  /**
   * Names the synchronous section the main thread is about to enter. Cheap
   * enough to call before every git spawn: one UTF-8 encode into shared
   * memory. Labels longer than LABEL_BYTES are cut; the worker only needs
   * enough to identify the call site.
   */
  mark(section: string): void {
    if (this.worker === null) return;
    const bytes = this.encoder.encode(section);
    const length = Math.min(bytes.length, LABEL_BYTES);
    // Length goes to zero first and back last, so a worker that reads
    // mid-write sees an empty label rather than a torn one.
    Atomics.store(this.labelLength, 0, 0);
    this.label.set(bytes.subarray(0, length));
    Atomics.store(this.labelLength, 0, length);
  }

  private beat(): void {
    Atomics.store(this.heartbeat, 0, BigInt(Date.now()));
  }
}

// The worker source sits beside this file in both layouts the daemon runs
// from: `.ts` under src/ (bun runs it directly, and the compiled sidecar
// embeds it — see apps/desktop/scripts/build-sidecars.ts) and `.js` under
// dist/ after tsc.
function workerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./watchdogWorker.${extension}`, import.meta.url);
}

let activeWatchdog: EventLoopWatchdog | null = null;

// A daemon process runs exactly one watchdog, so the marking seam below needs
// a module-level handle on it. Set through a function rather than by assigning
// `this` inside start(), which is the aliasing the lint rule warns about.
function setActiveWatchdog(watchdog: EventLoopWatchdog | null): void {
  activeWatchdog = watchdog;
}

/**
 * Labels the blocking section about to run on whichever watchdog is active —
 * the seam every synchronous git spawn calls so a stall report can name the
 * exact command and directory. A no-op when no watchdog is running (unit
 * tests that never start one).
 */
export function markBlockingSection(section: string): void {
  activeWatchdog?.mark(section);
}
