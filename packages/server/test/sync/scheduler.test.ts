import { ActorContext, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
  debounceMs: number
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
    new TaskStore(a).create({ title: 'Pending' });

    const events = new EventBus();
    const scheduler = schedulerFor(a, events, 15);

    expect(scheduler.pendingCounts()).toEqual({ outgoing: 1, incoming: 0 });

    scheduler.stop();
    rmSync(origin, { recursive: true, force: true });
  });
});
