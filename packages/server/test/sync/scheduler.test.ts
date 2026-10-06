import { ActorContext, TaskStore } from '@dispatch-foo/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '../../src/events.js';
import { EventBus } from '../../src/events.js';
import type { SyncResult } from '../../src/sync/boardSyncer.js';
import { BoardSyncer } from '../../src/sync/boardSyncer.js';
import { BoardSyncScheduler } from '../../src/sync/scheduler.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import { gitReaderFor, run, twoClones } from './helpers.js';

let fakeHome: string;
// Bumped after every test, so a test that timed out mid-advance() stops
// driving the clock instead of advancing the next test's timers.
let clockGeneration = 0;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Every test runs on fake timers: the scheduler's debounce and periodic
// timers only fire when a test advances the clock, so nothing here depends on
// how fast the machine is. Date is faked too, so timestamps are exact.
beforeEach(() => {
  jest.useFakeTimers();
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  clockGeneration++;
  // Drops whatever a failed test left armed, so it cannot fire in the next.
  jest.clearAllTimers();
  jest.useRealTimers();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

// twoClones() seeds config.yml with autoCommit: false; flip it to true for
// tests that exercise the scheduler with sync enabled.
function enableAutoCommit(dir: string): void {
  const path = join(dir, '.dispatch', 'config.yml');
  const contents = readFileSync(path, 'utf8').replace(
    'autoCommit: false',
    'autoCommit: true'
  );
  writeFileSync(path, contents);
}

function schedulerFor(
  dir: string,
  events: EventBus,
  debounceMs: number,
  periodicMs?: number
): BoardSyncScheduler {
  const worktree = SyncWorktree.open(dir, run);
  if (worktree === null) throw new Error('expected a resolvable trunk');
  const actor = ActorContext.resolve(dir, gitReaderFor(dir));
  return new BoardSyncScheduler({
    rootDir: dir,
    worktree,
    actor,
    run,
    events,
    debounceMs,
    periodicMs,
  });
}

// Stands in for BoardSyncer.syncOnce in tests about the timers alone. The
// scheduler treats every result alike, so a stubbed rejected push exercises
// the same path as a real one (boardSyncer.test.ts covers that) without
// seconds of git per attempt on a loaded machine.
function stubSyncs(state: SyncResult['state'] = 'idle'): {
  calls: () => number;
  restore: () => void;
} {
  const spy = spyOn(BoardSyncer.prototype, 'syncOnce').mockResolvedValue({
    pushed: 0,
    pulled: 0,
    state,
    detail: null,
  });
  return {
    calls: () => spy.mock.calls.length,
    restore: () => spy.mockRestore(),
  };
}

// Runs every promise continuation queued so far. setImmediate is not faked,
// so this waits on the real event loop rather than the fake clock.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Moves the fake clock forward one millisecond at a time, settling between
// steps the way a real event loop would: a sync a timer starts gets to finish
// (and clear its in-flight guard) before the next timer is due.
async function advance(ms: number): Promise<void> {
  const generation = clockGeneration;
  for (
    let elapsed = 0;
    elapsed < ms && generation === clockGeneration;
    elapsed++
  ) {
    jest.advanceTimersByTime(1);
    await settle();
  }
}

// Resolves with the next `board.sync` event's result. Subscribe before
// advancing the clock: a real sync can finish inside the advance call.
function nextBoardSync(events: EventBus): Promise<SyncResult> {
  return new Promise((resolve) => {
    const unsubscribe = events.subscribe((event) => {
      if (event.type !== 'board.sync') return;
      unsubscribe();
      resolve(event.result);
    });
  });
}

function collectBoardSyncEvents(events: EventBus): ServerEvent[] {
  const seen: ServerEvent[] = [];
  events.subscribe((event) => {
    if (event.type === 'board.sync') seen.push(event);
  });
  return seen;
}

describe('BoardSyncScheduler', () => {
  it('syncs after the debounce following a task-file change', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Debounced sync' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 20);

    scheduler.notifyTaskChanged();
    await advance(19);
    expect(seen.length).toBe(0);

    const synced = nextBoardSync(events);
    await advance(1);
    await synced;

    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      type: 'board.sync',
      result: { pushed: 1, state: 'idle' },
    });

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });

  it('coalesces a burst of edits into exactly one sync', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    const store = new TaskStore(a);
    store.create({ title: 'First' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 30);
    const syncs = stubSyncs();

    try {
      // A burst: several edits in quick succession, each re-arming the
      // timer — this must produce ONE sync, not one per call.
      for (let i = 0; i < 5; i++) {
        store.create({ title: `Burst ${i}` });
        scheduler.notifyTaskChanged();
        await advance(5);
      }
      expect(syncs.calls()).toBe(0);

      await advance(30);
      // Several more debounce windows: nothing was left armed to fire again.
      await advance(100);

      expect(syncs.calls()).toBe(1);
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatchObject({ type: 'board.sync' });
    } finally {
      scheduler.stop();
      syncs.restore();
    }
    rmSync(origin, { recursive: true, force: true });
  });

  it('autoCommit: false suppresses the sync entirely', async () => {
    const { origin, a } = twoClones();
    // twoClones() already seeds autoCommit: false — left as-is.
    new TaskStore(a).create({ title: 'Should not sync' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 20);

    scheduler.notifyTaskChanged();
    await advance(80);

    expect(seen.length).toBe(0);
    const worktree = SyncWorktree.open(a, run);
    expect(worktree).not.toBeNull();
    // Never even attempted: no commit, no push, nothing — the private sync
    // worktree is never created.
    expect(existsSync(worktree?.path ?? '')).toBe(false);

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });

  it('a failing sync does not retry itself — only the next real change tries again', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Will fail to push' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 15);
    const syncs = stubSyncs('local-only');

    try {
      scheduler.notifyTaskChanged();
      await advance(15);
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatchObject({
        type: 'board.sync',
        result: { state: 'local-only' },
      });

      // Several debounce windows elapse with no new change: a scheduler that
      // silently re-armed itself after the failure would sync again here.
      await advance(150);
      expect(syncs.calls()).toBe(1);
      expect(seen.length).toBe(1);
    } finally {
      scheduler.stop();
      syncs.restore();
    }
    rmSync(origin, { recursive: true, force: true });
  });

  it('retains the last result and when it happened, for GET /api/sync to read', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Track me' });

    const events = new EventBus();
    const scheduler = schedulerFor(a, events, 15);
    expect(scheduler.lastResult()).toBeNull();
    expect(scheduler.lastSyncedAt()).toBeNull();

    const synced = nextBoardSync(events);
    scheduler.notifyTaskChanged();
    await advance(15);
    await synced;

    expect(scheduler.lastResult()).toMatchObject({
      state: 'idle',
      pushed: 1,
    });
    const syncedAt = scheduler.lastSyncedAt();
    expect(syncedAt).not.toBeNull();
    expect(new Date(syncedAt ?? '').getTime()).not.toBeNaN();

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });

  it('exposes pendingCounts from its own BoardSyncer, read-only', () => {
    const { origin, a } = twoClones();
    // The sync worktree must already exist for pendingCounts() to report a
    // real count — it deliberately never calls ensure() itself (see
    // BoardSyncer.pendingCounts()'s own doc comment), so this test creates
    // it directly rather than relying on the read to do so as a side effect.
    const worktree = SyncWorktree.open(a, run);
    if (worktree === null) throw new Error('expected a resolvable trunk');
    worktree.ensure();
    new TaskStore(a).create({ title: 'Pending' });

    const events = new EventBus();
    const scheduler = schedulerFor(a, events, 15);

    expect(scheduler.pendingCounts()).toEqual({ outgoing: 1, incoming: 0 });

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });

  it('reports zeroes without creating the worktree when it does not already exist', () => {
    const { origin, a } = twoClones();
    new TaskStore(a).create({ title: 'Never synced' });

    const worktree = SyncWorktree.open(a, run);
    if (worktree === null) throw new Error('expected a resolvable trunk');
    expect(existsSync(worktree.path)).toBe(false);

    const events = new EventBus();
    const scheduler = schedulerFor(a, events, 15);

    expect(scheduler.pendingCounts()).toEqual({ outgoing: 0, incoming: 0 });
    expect(existsSync(worktree.path)).toBe(false);

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });
});

describe('BoardSyncScheduler periodic pull', () => {
  it('runs a sync on the periodic timer even with no local edit', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    // No TaskStore.create() at all — nothing changed locally. A silent
    // reader must still see a sync attempt.

    const events = new EventBus();
    // debounceMs kept enormous so only the periodic timer can produce a sync.
    const scheduler = schedulerFor(a, events, 999_000, 20);

    const synced = nextBoardSync(events);
    await advance(20);

    expect(await synced).toMatchObject({ state: 'idle', pushed: 0 });

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });

  it('autoCommit: false produces no periodic sync traffic', async () => {
    const { origin, a } = twoClones();
    // twoClones() already seeds autoCommit: false — left as-is.
    new TaskStore(a).create({ title: 'Should not periodic-sync' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 999_000, 20);

    await advance(100);

    expect(seen.length).toBe(0);
    const worktree = SyncWorktree.open(a, run);
    expect(worktree).not.toBeNull();
    expect(existsSync(worktree?.path ?? '')).toBe(false);

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });

  it('a failing periodic sync does not fire the timer faster than its interval', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Will fail to push, repeatedly' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const periodicMs = 30;
    const scheduler = schedulerFor(a, events, 999_000, periodicMs);
    const syncs = stubSyncs('local-only');

    try {
      await advance(periodicMs);
      expect(syncs.calls()).toBe(1);
      expect(seen[0]).toMatchObject({ result: { state: 'local-only' } });

      // Right up to the next tick, the failure has not brought a retry
      // forward — failures never shorten the interval into a retry storm.
      await advance(periodicMs - 1);
      expect(syncs.calls()).toBe(1);

      // The tick itself still retries, recovering from the outage.
      await advance(1);
      expect(syncs.calls()).toBe(2);
      expect(seen.length).toBe(2);
    } finally {
      scheduler.stop();
      syncs.restore();
    }

    rmSync(origin, { recursive: true, force: true });
  });

  it('stops the periodic timer on shutdown', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Stop me' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 999_000, 20);
    const syncs = stubSyncs();

    try {
      await advance(20);
      expect(seen.length).toBe(1);

      scheduler.stop();
      // The periodic interval was actually cleared, not just the debounce.
      expect(jest.getTimerCount()).toBe(0);
      await advance(100);
      expect(syncs.calls()).toBe(1);
      expect(seen.length).toBe(1);
    } finally {
      scheduler.stop();
      syncs.restore();
    }

    rmSync(origin, { recursive: true, force: true });
  });

  it('a syncOnce that throws does not crash the process and the timer keeps ticking', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Boom' });

    const events = new EventBus();
    const periodicMs = 20;
    // debounceMs kept enormous so only the periodic timer drives this test.
    const scheduler = schedulerFor(a, events, 999_000, periodicMs);

    let callCount = 0;
    const spy = spyOn(BoardSyncer.prototype, 'syncOnce').mockImplementation(
      function syncOnceStub() {
        callCount++;
        if (callCount === 1) {
          throw new Error('simulated worktree failure');
        }
        return Promise.resolve({
          pushed: 0,
          pulled: 0,
          state: 'idle' as const,
          detail: null,
        });
      }
    );

    // Registering a listener suppresses Bun/Node's default "crash the
    // process" behaviour for an unhandled rejection and instead hands it to
    // us, so a still-broken scheduler fails this test instead of killing the
    // whole test run.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const originalConsoleError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      // The first (throwing) tick, then the next one.
      await advance(periodicMs * 2);
    } finally {
      console.error = originalConsoleError;
      process.off('unhandledRejection', onUnhandledRejection);
      scheduler.stop();
      spy.mockRestore();
    }

    expect(unhandled).toEqual([]);
    expect(callCount).toBe(2);
    expect(errorCalls.length).toBe(1);

    rmSync(origin, { recursive: true, force: true });
  });

  it('does not run a second sync concurrently when a periodic tick lands mid-sync', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Overlap check' });

    const events = new EventBus();
    // debounceMs and periodicMs both short and close together, so several
    // periodic ticks land while the debounce-triggered sync below is still
    // "running" (per the stub) — proving the timer reuses the same
    // inFlight/pendingRerun guard rather than a second concurrency
    // mechanism of its own.
    const scheduler = schedulerFor(a, events, 10, 10);

    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const spy = spyOn(BoardSyncer.prototype, 'syncOnce').mockImplementation(
      async () => {
        calls++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent--;
        return { pushed: 0, pulled: 0, state: 'idle', detail: null };
      }
    );

    try {
      scheduler.notifyTaskChanged();
      await advance(180);
    } finally {
      scheduler.stop();
      spy.mockRestore();
    }

    // Syncs did run back to back through the window, never two at once.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(maxConcurrent).toBe(1);

    rmSync(origin, { recursive: true, force: true });
  });

  it('a slow periodic sync leaves an idle gap instead of running back-to-back', async () => {
    const { origin, a } = twoClones();
    enableAutoCommit(a);
    new TaskStore(a).create({ title: 'Slow sync' });

    const events = new EventBus();
    const periodicMs = 50;
    const syncDurationMs = 120;
    // debounceMs kept enormous so only the periodic timer drives this test.
    const scheduler = schedulerFor(a, events, 999_000, periodicMs);

    const startedAt = Date.now();
    const starts: number[] = [];
    const spy = spyOn(BoardSyncer.prototype, 'syncOnce').mockImplementation(
      async () => {
        starts.push(Date.now() - startedAt);
        await new Promise((resolve) => setTimeout(resolve, syncDurationMs));
        return { pushed: 0, pulled: 0, state: 'idle' as const, detail: null };
      }
    );

    try {
      await advance(800);
    } finally {
      scheduler.stop();
      spy.mockRestore();
    }

    // A tick landing mid-sync is dropped, not queued. Each sync spans the
    // two ticks after its own (+50, +100) and ends at +120; the next one
    // only starts at the tick after that (+150), after a real idle wait — a
    // queued tick would have started it back-to-back at +120.
    expect(starts).toEqual([50, 200, 350, 500, 650, 800]);

    rmSync(origin, { recursive: true, force: true });
  });
});
