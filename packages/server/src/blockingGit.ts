import type { SyncSpawnResult } from '@dispatch-foo/core';
import { childEnv, setSyncSpawner } from '@dispatch-foo/core';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

import type {
  BlockingGitRequest,
  BlockingGitResponse,
  BlockingGitWorkerData,
} from './blockingGitShared.js';
import { DONE_SLOT, READY_SLOT, SIGNAL_SLOTS } from './blockingGitShared.js';
import { markBlockingSection } from './watchdog.js';

export interface BlockingGitOptions {
  env?: Record<string, string | undefined>;
  /**
   * Hard deadline. The child is SIGKILLed, not SIGTERMed, when it expires:
   * a child that ignores SIGTERM (or is stuck in a syscall behind a stalled
   * ssh session) would turn a polite signal into no timeout at all — measured
   * against Bun.spawnSync on bun 1.3.14 and again on 1.4.2.
   */
  timeoutMs?: number;
}

export interface BlockingGitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when `timeoutMs` expired before git exited. */
  timedOut: boolean;
}

/**
 * How spawnGitSync is running git in this process. `worker` is the normal
 * state once the first call has brought the worker up; `fallback` means the
 * worker never came up — in a compiled daemon, that blockingGitWorker.ts was
 * not a build entrypoint (see apps/desktop/scripts/build-sidecars.ts) — and
 * every call is back on Bun.spawnSync. Surfaced at GET /api/health.
 */
export type BlockingGitStatus = 'idle' | 'worker' | 'fallback';

// How long the first call waits for the worker module to load before giving
// up on it for the life of the process.
const WORKER_READY_MS = 10_000;
// The main thread's own deadline for a call with no `timeoutMs`. A local git
// that is slow (a `git cherry` on a big repo) still finishes well inside it;
// one that has not answered in ten minutes has left the daemon dead anyway,
// and this is what turns that into an error instead of forever.
const UNBOUNDED_BACKSTOP_MS = 10 * 60_000;
// Slack past `timeoutMs` for the worker's SIGKILL to land and the pipes to
// drain before the main thread stops waiting on its own.
const DEADLINE_GRACE_MS = 5_000;

// Trims one argument for the watchdog label: a commit message or a patch body
// says nothing about *where* the daemon is stuck, the command shape does.
function shortArg(arg: string): string {
  const flat = arg.replace(/\s+/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}

/**
 * The one way the daemon runs git synchronously on its event loop.
 *
 * Every call here blocks HTTP, WebSockets and every timer for as long as git
 * takes, so each one first names itself to the event-loop watchdog: when the
 * loop stalls, the daemon log says `git pull --rebase origin main (cwd ...)`
 * instead of nothing. Local operations pass no timeout — a slow `git cherry`
 * on a big repo is slow, not stuck — while anything that can touch a network
 * or a prompt passes one and gets a real kill.
 *
 * Git does not run through Bun.spawnSync. On bun <= 1.4.2 spawnSync can lose
 * its child's exit and spin its private kqueue loop at 100% CPU forever
 * (oven-sh/bun#34069, fixed upstream by oven-sh/bun#44581): it points the VM
 * at that private loop for the duration of the call, so GC finalizers that
 * release polls during the wait decrement the wrong loop's counters. That is
 * the 2026-09-10 fix-loop hang, sampled as one native call alternating
 * kevent64 with lock traffic and no child alive — and the likeliest cause of
 * the 2026-08-23 daemon pegged at 100% CPU. Instead, a worker thread runs git
 * with the async Bun.spawn and the main thread sleeps in Atomics.wait (a
 * futex, not a poll) until the worker posts the result, with a deadline of
 * its own so not even a lost wakeup can hold the loop forever.
 */
export function spawnGitSync(
  cwd: string,
  args: string[],
  opts: BlockingGitOptions = {}
): BlockingGitResult {
  return spawnBlocking(['git', ...args], cwd, opts);
}

/**
 * spawnGitSync for any command: the same worker, deadline and watchdog
 * label. Throws when the command cannot be started at all.
 */
export function spawnBlocking(
  cmd: string[],
  cwd: string,
  opts: BlockingGitOptions = {}
): BlockingGitResult {
  markBlockingSection(`${cmd.map(shortArg).join(' ')} (cwd ${cwd})`);
  const env = opts.env ?? childEnv();
  const runner = readyRunner();
  const response =
    runner === null
      ? spawnWithBunSync(cmd, cwd, env, opts.timeoutMs)
      : runner.run(cmd, cwd, env, opts.timeoutMs);
  if (response.spawnError !== undefined) throw new Error(response.spawnError);
  let stderr = response.stderr;
  if (response.timedOut) {
    const name = cmd.slice(0, 2).join(' ');
    stderr = `${stderr}${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}${name} killed after ${String(opts.timeoutMs ?? UNBOUNDED_BACKSTOP_MS)}ms\n`;
  }
  return {
    exitCode: response.exitCode,
    stdout: response.stdout,
    stderr,
    timedOut: response.timedOut,
  };
}

/** How spawnGitSync is running git right now; see BlockingGitStatus. */
export function blockingGitStatus(): BlockingGitStatus {
  return status;
}

/**
 * Makes every synchronous spawn in @dispatch-foo/core (the merge-driver git
 * config, the carto probes) run through spawnBlocking instead of node's
 * spawnSync, which under Bun is Bun.spawnSync. Called once at boot;
 * idempotent.
 */
export function installBlockingSpawner(): void {
  setSyncSpawner((command, args, opts): SyncSpawnResult => {
    try {
      const result = spawnBlocking(
        [command, ...args],
        opts.cwd ?? process.cwd(),
        {
          env: opts.env,
        }
      );
      return {
        status: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      // node's spawnSync reports a failed start on the result, not by
      // throwing; core's callers read it there.
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

// The pre-worker path, kept only for a process whose worker cannot load.
function spawnWithBunSync(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number | undefined
): BlockingGitResponse {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    ...(timeoutMs !== undefined
      ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const }
      : {}),
  });
  return {
    id: 0,
    exitCode: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    timedOut: result.exitedDueToTimeout === true,
  };
}

// The worker source sits beside this file in both layouts the daemon runs
// from, as watchdog.ts's does: `.ts` under src/ and `.js` under dist/.
function workerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./blockingGitWorker.${extension}`, import.meta.url);
}

/**
 * The main thread's handle on the git worker: posts one request at a time
 * and blocks until the matching result is on the `results` port.
 */
class WorkerRunner {
  private nextId = 1;

  constructor(
    readonly worker: Worker,
    private readonly signal: Int32Array,
    private readonly results: MessagePort
  ) {}

  run(
    cmd: string[],
    cwd: string,
    env: Record<string, string | undefined>,
    timeoutMs: number | undefined
  ): BlockingGitResponse {
    const id = this.nextId++;
    const request: BlockingGitRequest = {
      type: 'run',
      id,
      cmd,
      cwd,
      env,
      timeoutMs,
    };
    this.worker.postMessage(request);
    const budget =
      timeoutMs === undefined
        ? UNBOUNDED_BACKSTOP_MS
        : timeoutMs + DEADLINE_GRACE_MS;
    const deadline = performance.now() + budget;
    for (;;) {
      const response = this.take(id);
      if (response !== null) return response;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const done = Atomics.load(this.signal, DONE_SLOT);
      // `done === id` with nothing on the port yet is the instant between
      // the worker's post and its delivery; re-check almost at once rather
      // than sleep on a slot that will not change again.
      Atomics.wait(
        this.signal,
        DONE_SLOT,
        done,
        done === id ? 1 : Math.min(remaining, 1_000)
      );
    }
    const cancel: BlockingGitRequest = { type: 'cancel', id };
    this.worker.postMessage(cancel);
    return { id, exitCode: null, stdout: '', stderr: '', timedOut: true };
  }

  // Drains the port up to the result for `id`. Anything older belongs to a
  // call that already gave up waiting, and is dropped.
  private take(id: number): BlockingGitResponse | null {
    for (;;) {
      const received = receiveMessageOnPort(this.results);
      if (received === undefined) return null;
      const response = received.message as BlockingGitResponse;
      if (response.id === id) return response;
    }
  }
}

let status: BlockingGitStatus = 'idle';
let runner: WorkerRunner | null = null;

/**
 * The process's git worker, started on first use and kept for the life of
 * the process (never terminated, for the same Bun fd leak as the watchdog's
 * shared worker). Null once the worker has failed to come up, which sends
 * every call back to Bun.spawnSync — a daemon that can still run git, and
 * says at /api/health that it is exposed again.
 */
function readyRunner(): WorkerRunner | null {
  if (runner !== null || status === 'fallback') return runner;
  const signal = new Int32Array(
    new SharedArrayBuffer(SIGNAL_SLOTS * Int32Array.BYTES_PER_ELEMENT)
  );
  const channel = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(workerUrl());
  } catch (error) {
    return fallBack(error instanceof Error ? error.message : String(error));
  }
  worker.unref();
  const init: BlockingGitWorkerData = {
    signal: signal.buffer,
    results: channel.port2,
  };
  worker.postMessage(init, [channel.port2]);
  // The main thread cannot see the worker's `error` event while it blocks,
  // so readiness is a flag the worker raises itself once it has its init.
  if (Atomics.wait(signal, READY_SLOT, 0, WORKER_READY_MS) === 'timed-out') {
    worker.terminate();
    return fallBack(`worker not ready after ${String(WORKER_READY_MS)}ms`);
  }
  const started = new WorkerRunner(worker, signal, channel.port1);
  worker.addEventListener('error', (event: ErrorEvent) => {
    console.error(`dispatchd: git worker stopped: ${event.message}`);
    // The next call starts a fresh worker.
    if (runner === started) runner = null;
    status = 'idle';
  });
  runner = started;
  status = 'worker';
  return started;
}

function fallBack(reason: string): null {
  console.error(
    `dispatchd: git worker unavailable (${reason}); synchronous git falls back to Bun.spawnSync`
  );
  status = 'fallback';
  return null;
}
