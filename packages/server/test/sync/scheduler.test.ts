import { ActorContext, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '../../src/events.js';
import { EventBus } from '../../src/events.js';
import { BoardSyncer } from '../../src/sync/boardSyncer.js';
import { BoardSyncScheduler } from '../../src/sync/scheduler.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import { gitReaderFor, run, twoClones } from './helpers.js';

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
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

// Mirrors boardSyncer.test.ts's own helper: a pre-receive hook is a
// deterministic, cross-platform way to force a rejected push.
function installRejectingHook(bareRepo: string): void {
  const hooksDir = join(bareRepo, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-receive');
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  chmodSync(hookPath, 0o755);
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
    expect(seen.length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));

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

    // A burst: several edits in quick succession, each re-arming the timer —
    // this must produce ONE sync, not one per call.
    for (let i = 0; i < 5; i++) {
      store.create({ title: `Burst ${i}` });
      scheduler.notifyTaskChanged();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ type: 'board.sync' });

    scheduler.stop();
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
    await new Promise((resolve) => setTimeout(resolve, 80));

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
    installRejectingHook(origin);
    new TaskStore(a).create({ title: 'Will fail to push' });

    const events = new EventBus();
    const seen = collectBoardSyncEvents(events);
    const scheduler = schedulerFor(a, events, 15);

    scheduler.notifyTaskChanged();
    // Long enough for several debounce windows to have elapsed if the
    // scheduler were silently re-arming itself after the failure — proves
    // absence, not just an unlucky timing window.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      type: 'board.sync',
      result: { state: 'local-only' },
    });

    scheduler.stop();
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

    scheduler.notifyTaskChanged();
    await new Promise((resolve) => setTimeout(resolve, 80));

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
    const seen = collectBoardSyncEvents(events);
    // debounceMs kept enormous so only the periodic timer can produce a sync.
    const scheduler = schedulerFor(a, events, 999_000, 20);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toMatchObject({
      type: 'board.sync',
      result: { state: 'idle', pushed: 0 },
    });

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

    await new Promise((resolve) => setTimeout(resolve, 100));

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
    installRejectingHook(origin);
    new TaskStore(a).create({ title: 'Will fail to push, repeatedly' });

    const events = new EventBus();
    const timestamps: number[] = [];
    events.subscribe((event) => {
      if (event.type === 'board.sync') timestamps.push(Date.now());
    });
    const periodicMs = 30;
    const scheduler = schedulerFor(a, events, 999_000, periodicMs);

    await new Promise((resolve) => setTimeout(resolve, 160));
    scheduler.stop();

    // At least two attempts in this window prove the timer is actually
    // retrying (recovering from the outage), not just proving absence.
    expect(timestamps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < timestamps.length; i++) {
      // A small tolerance below periodicMs for scheduler/GC jitter — proves
      // failures never shorten the interval into a retry storm.
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(
        periodicMs - 10
      );
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

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(seen.length).toBeGreaterThanOrEqual(1);

    scheduler.stop();
    const countAtStop = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No further syncs land after stop() — the periodic interval was
    // actually cleared, not just the debounce.
    expect(seen.length).toBe(countAtStop);

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
      // Long enough for the first (throwing) tick plus at least one more.
      await new Promise((resolve) => setTimeout(resolve, periodicMs * 4 + 40));
    } finally {
      console.error = originalConsoleError;
      process.off('unhandledRejection', onUnhandledRejection);
      scheduler.stop();
      spy.mockRestore();
    }

    expect(unhandled).toEqual([]);
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);

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

    let concurrent = 0;
    let maxConcurrent = 0;
    const spy = spyOn(BoardSyncer.prototype, 'syncOnce').mockImplementation(
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent--;
        return { pushed: 0, pulled: 0, state: 'idle', detail: null };
      }
    );

    scheduler.notifyTaskChanged();
    await new Promise((resolve) => setTimeout(resolve, 180));
    scheduler.stop();
    spy.mockRestore();

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

    const starts: number[] = [];
    const spy = spyOn(BoardSyncer.prototype, 'syncOnce').mockImplementation(
      async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, syncDurationMs));
        return { pushed: 0, pulled: 0, state: 'idle' as const, detail: null };
      }
    );

    // Long enough for several sync cycles at (periodicMs + syncDurationMs)
    // pace, so a still-buggy scheduler (back-to-back, no idle gap) and a
    // fixed one (idle until the next tick) produce a clearly different count.
    await new Promise((resolve) => setTimeout(resolve, 800));
    scheduler.stop();
    spy.mockRestore();

    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      // A tick landing mid-sync must be dropped, not queued: the next sync
      // only starts at a later tick, once the previous one is done — so the
      // gap is always a real idle wait beyond the sync's own duration, never
      // just the duration itself (back-to-back, zero idle time).
      expect(gap).toBeGreaterThan(syncDurationMs + periodicMs / 2);
    }

    rmSync(origin, { recursive: true, force: true });
  });
});
