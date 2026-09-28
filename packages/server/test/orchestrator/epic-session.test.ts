import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus, type ServerEvent } from '../../src/events.js';
import { EpicEngine } from '../../src/orchestrator/epic.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import type { FixLoopState } from '../../src/orchestrator/fixLoop.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { epicSessionsPath } from '../../src/orchestrator/paths.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
} from '../../src/orchestrator/types.js';
import { initGitRepo, WatchedTaskStore, withBrokenRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
// Shut down in afterEach: an engine's retry timers outlive its test otherwise.
const engines: EpicEngine[] = [];
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-epic-session-');
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.shutdown();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  orchestrator: Orchestrator;
  epics: EpicEngine;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  received: ServerEvent[];
}

interface HarnessOptions {
  costUsd?: number;
  fillRetryDelayMs?: number;
  resumeDelayMs?: number;
  eventDebounceMs?: number;
  store?: TaskStore;
}

// The epic.test.ts harness with the seams these tests turn: the fake's cost
// per finished run (the spend gate's settled term), the fill-retry delay,
// the boot re-arm delay and the event debounce (0 = synchronous). Every
// broadcast lands in `received` so a test can assert on the epic events.
function makeHarness(opts: HarnessOptions = {}): Harness {
  const store = opts.store ?? TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const received: ServerEvent[] = [];
  events.subscribe((event) => received.push(event));
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      steps: [{ approval: { requestId: 'go', toolName: 'noop', input: {} } }],
      finish: { state: 'finished', costUsd: opts.costUsd ?? 0, turns: 1 },
    })
  );
  const epics = new EpicEngine({
    rootDir: repo,
    store,
    cache,
    events,
    orchestrator,
    fillRetryDelayMs: opts.fillRetryDelayMs,
    resumeDelayMs: opts.resumeDelayMs,
    eventDebounceMs: opts.eventDebounceMs ?? 0,
  });
  engines.push(epics);
  // The test's own writes, seen the way a hand edit is: through a refresh.
  const watched = new WatchedTaskStore(repo, cache);
  return { orchestrator, epics, store: watched, cache, events, received };
}

function createEpicWithChildren(
  store: TaskStore,
  count: number,
  blockedBy: (i: number, ids: string[]) => string[] = () => []
): { epicId: string; childIds: string[] } {
  const epic = store.create({ title: 'Test epic', kind: 'epic' });
  const childIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const doc = store.create({
      title: `Child ${i}`,
      kind: 'task',
      parent: epic.meta.id,
      writes: [`child-${i}.ts`],
    });
    childIds.push(doc.meta.id);
  }
  childIds.forEach((id, i) => {
    const deps = blockedBy(i, childIds);
    if (deps.length > 0) store.update(id, { blockedBy: deps });
  });
  return { epicId: epic.meta.id, childIds };
}

function awaiting(h: Harness, childIds: string[]) {
  const set = new Set(childIds);
  return h.orchestrator
    .list()
    .filter((r) => set.has(r.taskId) && r.state === 'awaiting-approval');
}

function runsOn(h: Harness, childIds: string[]) {
  const set = new Set(childIds);
  return h.orchestrator.list().filter((r) => set.has(r.taskId));
}

function activity(h: Harness, epicId: string): string {
  return h.store.get(epicId)?.body ?? '';
}

function pausedEvents(h: Harness) {
  return h.received.filter((e) => e.type === 'epic.paused');
}

describe('EpicEngine run ceiling', () => {
  it('pauses with `runs` once maxRuns runs exist and never starts run N+1', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(h.store, 5);

    const session = await h.epics.start(epicId, {
      executor: 'fake',
      concurrency: 2,
      maxRuns: 3,
    });
    expect(session.maxRuns).toBe(3);
    expect(session.state).toBe('active');
    await waitFor(() => awaiting(h, childIds).length === 2);
    expect(runsOn(h, childIds)).toHaveLength(2);

    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await waitFor(() => runsOn(h, childIds).length === 3);
    await sleep(30);
    expect(h.epics.progress(epicId).session?.state).toBe('active');

    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await waitFor(() => h.epics.progress(epicId).session?.state === 'paused');
    expect(runsOn(h, childIds)).toHaveLength(3);
    const paused = h.epics.progress(epicId).session!;
    expect(paused.pausedReason).toBe('runs');
    expect(paused.active).toBe(false);
    expect(activity(h, epicId)).toContain(
      'epic dispatch paused — run ceiling reached (3/3 runs)'
    );

    // The self-carrying event: the numbers, no fetch needed.
    expect(pausedEvents(h)).toEqual([
      {
        type: 'epic.paused',
        epicId,
        reason: 'runs',
        settledUsd: 0,
        estimatedLiveUsd: 10,
        maxSpendUsd: null,
        runsStarted: 3,
        maxRuns: 3,
      },
    ]);

    // Still paused after the last live run settles — no future terminal
    // can free a run.
    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await sleep(60);
    expect(runsOn(h, childIds)).toHaveLength(3);
    expect(h.epics.progress(epicId).session?.state).toBe('paused');
  });

  it('a 3 → 6 → 1 staged epic dispatches wave by wave and pauses at maxRuns: 8', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(
      h.store,
      10,
      (i, ids) => {
        if (i < 3) return [];
        if (i < 9) return ids.slice(0, 3);
        return ids.slice(3, 9);
      }
    );
    h.cache.rebuild(h.store);
    const readers = childIds.slice(0, 3);
    const workers = childIds.slice(3, 9);
    const synth = childIds[9];

    await h.epics.start(epicId, {
      executor: 'fake',
      concurrency: 3,
      maxRuns: 8,
    });
    await waitFor(() => awaiting(h, readers).length === 3);
    const waves = h.epics.progress(epicId).waves;
    expect(waves.map((w) => [w.index, w.total])).toEqual([
      [1, 3],
      [2, 6],
      [3, 1],
    ]);
    expect(waves[0].byPhase).toEqual({ working: 3 });
    expect(waves[1].byPhase).toEqual({ waiting: 6 });

    // Approving two readers frees slots, but no worker is dispatchable
    // until the third reader is in review too.
    const readerRuns = awaiting(h, readers);
    h.orchestrator.approve(readerRuns[0].id, 'go', true);
    h.orchestrator.approve(readerRuns[1].id, 'go', true);
    await sleep(60);
    expect(runsOn(h, workers)).toHaveLength(0);
    h.orchestrator.approve(readerRuns[2].id, 'go', true);
    await waitFor(() =>
      readers.every((id) => h.store.get(id)?.meta.status === 'review')
    );
    // Merged, not just reviewed: a worker with three unmerged blockers needs
    // a multi-parent base, which the orchestrator only builds with jj.
    for (const run of readerRuns) h.orchestrator.review(run.id, 'merge');
    await waitFor(() => awaiting(h, workers).length === 3);
    expect(runsOn(h, synth === undefined ? [] : [synth])).toHaveLength(0);

    // Runs 7 and 8 are the fourth and fifth workers; the sixth never starts.
    h.orchestrator.approve(awaiting(h, workers)[0].id, 'go', true);
    await waitFor(() => runsOn(h, workers).length === 4);
    h.orchestrator.approve(awaiting(h, workers)[0].id, 'go', true);
    await waitFor(() => runsOn(h, workers).length === 5);
    h.orchestrator.approve(awaiting(h, workers)[0].id, 'go', true);
    await waitFor(() => h.epics.progress(epicId).session?.state === 'paused');
    expect(h.epics.progress(epicId).session?.pausedReason).toBe('runs');
    expect(runsOn(h, childIds)).toHaveLength(8);
    expect(h.epics.progress(epicId).spend.runsStarted).toBe(8);
    expect(h.epics.progress(epicId).waves[2].byPhase).toEqual({ waiting: 1 });
    // Three real merges plus eight fake runs sit near bun's 5s default.
  }, 20_000);
});

describe('EpicEngine spend ceiling', () => {
  it('waits while a run is live and pauses with `budget` only once nothing is', async () => {
    const h = makeHarness({ costUsd: 10 });
    const { epicId, childIds } = createEpicWithChildren(h.store, 5);

    // Estimate is the default $10/run: floor(25 / 10) = 2 fit at first.
    await h.epics.start(epicId, {
      executor: 'fake',
      concurrency: 2,
      maxSpendUsd: 25,
    });
    await waitFor(() => awaiting(h, childIds).length === 2);
    expect(h.epics.progress(epicId).spend).toEqual({
      settledUsd: 0,
      liveCount: 2,
      estimatedLiveUsd: 20,
      runsStarted: 2,
      maxSpendUsd: 25,
      maxRuns: null,
    });

    // $10 settled + ~$10 live leaves $5 — below one run, but a run is still
    // live so the session waits for its settle rather than pausing.
    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await waitFor(() => h.epics.progress(epicId).spend.settledUsd === 10);
    await sleep(60);
    expect(runsOn(h, childIds)).toHaveLength(2);
    expect(h.epics.progress(epicId).session?.state).toBe('active');
    expect(pausedEvents(h)).toHaveLength(0);

    // Nothing live and $5 left: pause.
    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await waitFor(() => h.epics.progress(epicId).session?.state === 'paused');
    expect(h.epics.progress(epicId).session?.pausedReason).toBe('budget');
    expect(runsOn(h, childIds)).toHaveLength(2);
    expect(activity(h, epicId)).toContain(
      'epic dispatch paused — spend ceiling reached ($20.00 settled + ~$0.00 in flight of $25.00)'
    );
    expect(pausedEvents(h)).toEqual([
      {
        type: 'epic.paused',
        epicId,
        reason: 'budget',
        settledUsd: 20,
        estimatedLiveUsd: 0,
        maxSpendUsd: 25,
        runsStarted: 2,
        maxRuns: null,
      },
    ]);

    // Raising the ceiling refills; startedAt is untouched so the $20 still
    // counts.
    const before = h.epics.progress(epicId).session!.startedAt;
    const resumed = await h.epics.resume(epicId, { maxSpendUsd: 100 });
    expect(resumed.state).toBe('active');
    expect(resumed.maxSpendUsd).toBe(100);
    expect(resumed.pausedReason).toBeUndefined();
    expect(resumed.startedAt).toBe(before);
    await waitFor(() => awaiting(h, childIds).length === 2);
    expect(runsOn(h, childIds)).toHaveLength(4);
    expect(h.epics.progress(epicId).spend.settledUsd).toBe(20);
    expect(activity(h, epicId)).toContain(
      'epic dispatch resumed (concurrency 2, ceiling $100.00)'
    );
  }, 20_000);
});

describe('EpicEngine session transitions', () => {
  it('start 409s on a paused session, and stop works from paused', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(h.store, 3);
    await h.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(h, childIds).length === 1);

    const paused = h.epics.pause(epicId);
    expect(paused.state).toBe('paused');
    expect(paused.pausedReason).toBe('human');
    expect(paused.active).toBe(false);
    expect(activity(h, epicId)).toContain(
      'epic dispatch paused by you (live runs continue)'
    );
    // A human's pause carries no epic.paused event — only automatic ones do.
    expect(pausedEvents(h)).toHaveLength(0);

    await expect(h.epics.start(epicId, { executor: 'fake' })).rejects.toThrow(
      /resume or stop it first/
    );
    expect(() => h.epics.pause(epicId)).toThrow(OrchestratorConflictError);

    // The live run finishing does not refill a paused session, and does not
    // complete it either.
    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await sleep(60);
    expect(runsOn(h, childIds)).toHaveLength(1);
    expect(h.epics.progress(epicId).session?.state).toBe('paused');

    const stopped = h.epics.stop(epicId);
    expect(stopped.state).toBe('stopped');
    expect(stopped.pausedReason).toBeUndefined();
    expect(() => h.epics.stop(epicId)).toThrow(OrchestratorConflictError);
    await expect(h.epics.resume(epicId)).rejects.toThrow(
      OrchestratorConflictError
    );

    // A stopped session may be started over, with a fresh startedAt.
    const again = await h.epics.start(epicId, { executor: 'fake' });
    expect(again.state).toBe('active');
    expect(again.startedAt > stopped.startedAt).toBe(true);
  });

  it('resume applies validated overrides and 409s unless paused', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(h.store, 3);
    await h.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(h, childIds).length === 1);
    await expect(h.epics.resume(epicId)).rejects.toThrow(
      OrchestratorConflictError
    );

    h.epics.pause(epicId);
    await expect(h.epics.resume(epicId, { concurrency: 0 })).rejects.toThrow(
      OrchestratorClientError
    );
    await expect(h.epics.resume(epicId, { maxRuns: 1.5 })).rejects.toThrow(
      OrchestratorClientError
    );
    await expect(h.epics.resume(epicId, { maxSpendUsd: -1 })).rejects.toThrow(
      OrchestratorClientError
    );
    // A rejected override leaves the session paused and untouched.
    expect(h.epics.progress(epicId).session?.state).toBe('paused');
    expect(h.epics.progress(epicId).session?.concurrency).toBe(1);

    const resumed = await h.epics.resume(epicId, {
      concurrency: 2,
      maxRuns: 5,
    });
    expect(resumed.concurrency).toBe(2);
    expect(resumed.maxRuns).toBe(5);
    expect(resumed.maxSpendUsd).toBeNull();
    await waitFor(() => awaiting(h, childIds).length === 2);
  });

  it('start validates the ceilings and the configured maxConcurrency before any state', async () => {
    const h = makeHarness();
    const { epicId } = createEpicWithChildren(h.store, 1);
    await expect(
      h.epics.start(epicId, { executor: 'fake', concurrency: 33 })
    ).rejects.toThrow(/between 1 and 16/);
    await expect(
      h.epics.start(epicId, { executor: 'fake', maxSpendUsd: 0 })
    ).rejects.toThrow(OrchestratorClientError);
    await expect(
      h.epics.start(epicId, { executor: 'fake', maxSpendUsd: Infinity })
    ).rejects.toThrow(OrchestratorClientError);
    await expect(
      h.epics.start(epicId, { executor: 'fake', maxRuns: 0 })
    ).rejects.toThrow(OrchestratorClientError);
    expect(h.epics.progress(epicId).session).toBeNull();
    expect(existsSync(epicSessionsPath(repo))).toBe(false);

    // The cap is config, not a literal.
    writeFileSync(
      join(repo, '.dispatch', 'config.yml'),
      'orchestrator:\n  maxConcurrency: 20\n'
    );
    const session = await h.epics.start(epicId, {
      executor: 'fake',
      concurrency: 20,
      maxSpendUsd: 60,
      maxRuns: 20,
    });
    expect(session.concurrency).toBe(20);
    expect(activity(h, epicId)).toContain(
      'epic dispatch started (concurrency 20, ceiling $60.00, max 20 runs)'
    );
  });

  it('does not complete while a child in review still has a live review run', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(h.store, 2);
    const [aId, bId] = childIds;
    await h.epics.start(epicId, { executor: 'fake', concurrency: 2 });
    await waitFor(() => awaiting(h, childIds).length === 2);

    const runA = awaiting(h, [aId])[0];
    h.orchestrator.approve(runA.id, 'go', true);
    await waitFor(() => h.store.get(aId)?.meta.status === 'review');
    const review = await h.orchestrator.dispatchAuxRun({
      taskId: aId,
      kind: 'review',
      head: 'HEAD',
      executor: 'fake',
      buildPrompt: () => 'review it',
    });
    await waitFor(() => awaiting(h, [aId]).length === 1);
    expect(
      h.epics.progress(epicId).children.find((c) => c.id === aId)
    ).toMatchObject({
      phase: 'reviewing',
      runId: review.id,
    });

    // B settles: every child has left ready/working, but A's review is live.
    h.orchestrator.approve(awaiting(h, [bId])[0].id, 'go', true);
    await waitFor(() => h.store.get(bId)?.meta.status === 'review');
    await sleep(60);
    expect(h.epics.progress(epicId).session?.state).toBe('active');

    h.orchestrator.approve(review.id, 'go', true);
    await waitFor(() => h.epics.progress(epicId).session?.state === 'complete');
    expect(h.epics.progress(epicId).session?.completedAt).toBeDefined();
    expect(h.epics.progress(epicId).active).toBe(false);
  });

  it('a session with only a fix loop in flight stays active; capped alone completes', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(h.store, 1);
    const loops = new Map<string, FixLoopState>();
    h.epics.bindFixLoop({
      get: (taskId) => loops.get(taskId) ?? null,
      list: () => [...loops.values()],
    });
    const loop = (state: FixLoopState['state']): FixLoopState => ({
      taskId: childIds[0],
      round: 1,
      cap: 3,
      state,
      baseSha: 'x',
      lastReviewedSha: null,
      updatedAt: '2026-09-20T00:00:00Z',
    });

    await h.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(h, childIds).length === 1);
    loops.set(childIds[0], loop('reviewing'));
    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await waitFor(() => h.store.get(childIds[0])?.meta.status === 'review');
    await sleep(60);
    expect(h.epics.progress(epicId).session?.state).toBe('active');
    expect(h.epics.progress(epicId).children[0].phase).toBe('reviewing');

    // Capped is the human's queue, not this session's work — the next
    // terminal event anywhere lets it complete.
    loops.set(childIds[0], loop('capped'));
    const other = h.store.create({ title: 'Elsewhere' });
    const otherRun = await h.orchestrator.dispatch(other.meta.id, 'fake');
    await waitFor(() => awaiting(h, [other.meta.id]).length === 1);
    h.orchestrator.approve(otherRun.id, 'go', true);
    await waitFor(() => h.epics.progress(epicId).session?.state === 'complete');
  });
});

describe('EpicEngine events', () => {
  it('broadcasts epic.changed synchronously with a 0 debounce, on every transition', async () => {
    const h = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(h.store, 2);
    const changed = () =>
      h.received.filter(
        (e) => e.type === 'epic.changed' && e.epicId === epicId
      );

    await h.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    // One for the batch the initial fill dispatched, one for start() itself.
    expect(changed()).toHaveLength(2);
    h.epics.pause(epicId);
    expect(changed()).toHaveLength(3);
    await h.epics.resume(epicId);
    expect(changed().length).toBeGreaterThanOrEqual(4);
    h.epics.stop(epicId);
    const afterStop = changed().length;
    h.orchestrator.approve(awaiting(h, childIds)[0].id, 'go', true);
    await sleep(40);
    // A stopped session reacts to nothing.
    expect(changed()).toHaveLength(afterStop);
  });

  it('collapses several emits inside the debounce window into one broadcast', async () => {
    const h = makeHarness({ eventDebounceMs: 20 });
    const { epicId } = createEpicWithChildren(h.store, 2);
    await h.epics.start(epicId, { executor: 'fake', concurrency: 2 });
    expect(h.received.filter((e) => e.type === 'epic.changed')).toHaveLength(0);
    await sleep(60);
    expect(h.received.filter((e) => e.type === 'epic.changed')).toEqual([
      { type: 'epic.changed', epicId },
    ]);
  });
});

describe('EpicEngine fill failure', () => {
  it('pauses with fill-failed and the message after the retry budget', async () => {
    const h = makeHarness({ fillRetryDelayMs: 5 });
    const { epicId, childIds } = createEpicWithChildren(h.store, 2);
    await h.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(h, childIds).length === 1);

    const runId = awaiting(h, childIds)[0].id;
    await withBrokenRepo(repo, async () => {
      h.orchestrator.approve(runId, 'go', true);
      await waitFor(() => h.epics.progress(epicId).session?.state === 'paused');
    });
    const session = h.epics.progress(epicId).session!;
    expect(session.pausedReason).toBe('fill-failed');
    expect(session.pausedDetail).toContain('git');
    expect(activity(h, epicId)).toContain(
      'epic dispatch paused — auto-dispatch kept failing:'
    );
    const paused = pausedEvents(h);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({
      reason: 'fill-failed',
      detail: session.pausedDetail,
      runsStarted: 1,
    });
    // Once the repo is back, resume refills.
    await h.epics.resume(epicId);
    await waitFor(() => awaiting(h, childIds).length === 1);
    expect(runsOn(h, childIds)).toHaveLength(2);
  });

  it('shutdown cancels a pending retry, so nothing fills or persists after it', async () => {
    const h = makeHarness({ fillRetryDelayMs: 20 });
    const { epicId, childIds } = createEpicWithChildren(h.store, 2);
    await h.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(h, childIds).length === 1);

    const runId = awaiting(h, childIds)[0].id;
    await withBrokenRepo(repo, async () => {
      h.orchestrator.approve(runId, 'go', true);
      await waitFor(() =>
        activity(h, epicId).includes('[hook error] auto-dispatch failed')
      );
      h.epics.shutdown();
      rmSync(epicSessionsPath(repo), { force: true });
      // Past the whole retry budget: without shutdown this pauses and writes.
      await sleep(150);
    });
    expect(existsSync(epicSessionsPath(repo))).toBe(false);
    expect(h.epics.progress(epicId).session?.state).toBe('active');
    expect(pausedEvents(h)).toHaveLength(0);
  });
});

describe('EpicEngine persistence', () => {
  it('a second engine hydrates the record, stays unarmed until resumeDelayMs, then fills', async () => {
    const first = makeHarness({ costUsd: 10 });
    const { epicId, childIds } = createEpicWithChildren(first.store, 3);
    await first.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(first, childIds).length === 1);
    first.orchestrator.approve(awaiting(first, childIds)[0].id, 'go', true);
    await waitFor(() => runsOn(first, childIds).length === 2);
    const before = first.epics.progress(epicId);
    expect(before.spend.settledUsd).toBe(10);
    expect(before.spend.runsStarted).toBe(2);

    const file = JSON.parse(readFileSync(epicSessionsPath(repo), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.sessions[epicId].state).toBe('active');
    expect(file.sessions[epicId].heldCritical).toEqual([]);

    // The "restart": a fresh orchestrator replays the transcripts (and
    // force-fails the run the dead process left live), a fresh engine
    // reads the sidecar.
    const second = makeHarness({
      costUsd: 10,
      resumeDelayMs: 150,
      store: first.store,
    });
    second.orchestrator.reconcileOnBoot();
    const after = second.epics.progress(epicId);
    expect(after.session).toEqual(before.session);
    expect(after.spend.settledUsd).toBe(before.spend.settledUsd);
    expect(after.spend.runsStarted).toBe(before.spend.runsStarted);

    expect(second.epics.resumeOnBoot()).toBe(1);
    // A terminal event before the timer only re-checks completion.
    await sleep(60);
    expect(second.orchestrator.list()).toHaveLength(2);
    expect(second.epics.progress(epicId).session?.state).toBe('active');

    await waitFor(() => second.orchestrator.list().length === 3, 3000);
    expect(awaiting(second, childIds)).toHaveLength(1);
  });

  it('a paused or stopped session is hydrated as-is and never re-armed', async () => {
    const first = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(first.store, 2);
    await first.epics.start(epicId, { executor: 'fake', concurrency: 1 });
    await waitFor(() => awaiting(first, childIds).length === 1);
    first.epics.pause(epicId);

    const second = makeHarness({ resumeDelayMs: 10, store: first.store });
    expect(second.epics.resumeOnBoot()).toBe(0);
    const session = second.epics.progress(epicId).session!;
    expect(session.state).toBe('paused');
    expect(session.pausedReason).toBe('human');
    await expect(
      second.epics.start(epicId, { executor: 'fake' })
    ).rejects.toThrow(OrchestratorConflictError);
  });

  it('a garbage sidecar boots with no sessions and one console.error', () => {
    mkdirSync(join(epicSessionsPath(repo), '..'), { recursive: true });
    writeFileSync(epicSessionsPath(repo), '{not json');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = makeHarness();
      const { epicId } = createEpicWithChildren(h.store, 1);
      expect(h.epics.progress(epicId).session).toBeNull();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toContain(
        'failed to read epic sessions'
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('drops an entry whose state is not one of the four', () => {
    mkdirSync(join(epicSessionsPath(repo), '..'), { recursive: true });
    const h0 = makeHarness();
    const { epicId } = createEpicWithChildren(h0.store, 1);
    writeFileSync(
      epicSessionsPath(repo),
      JSON.stringify({
        version: 1,
        sessions: {
          [epicId]: {
            concurrency: 2,
            executor: 'fake',
            state: 'running',
            maxSpendUsd: null,
            maxRuns: null,
            startedAt: '2026-09-20T00:00:00Z',
            updatedAt: '2026-09-20T00:00:00Z',
            heldCritical: [],
          },
        },
      })
    );
    const h = makeHarness({ store: h0.store });
    expect(h.epics.progress(epicId).session).toBeNull();
  });
});

describe('EpicEngine progress phases', () => {
  it('derives the §3.3 phase per child and the wave per blockedBy depth', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'Epic', kind: 'epic' });
    const mk = (title: string, extra: Record<string, unknown> = {}) =>
      h.store.create({
        title,
        kind: 'task',
        parent: epic.meta.id,
        writes: [`${title}.ts`],
        ...extra,
      }).meta.id;
    const working = mk('working');
    const held = mk('held', { risk: 'critical' });
    const waiting = mk('waiting', { blockedBy: [working] });
    const third = mk('third', { blockedBy: [waiting] });
    const queued = mk('queued');
    const reviewing = mk('reviewing', { status: 'review' });
    const capped = mk('capped', { status: 'review' });
    const landed = mk('landed', { status: 'landed' });
    const needsReview = mk('needs-review', { status: 'review' });
    const draft = mk('draft', { status: 'draft' });
    h.cache.rebuild(h.store);

    h.epics.bindFixLoop({
      get: (taskId) =>
        taskId === capped
          ? {
              taskId,
              round: 3,
              cap: 3,
              state: 'capped',
              stopReason: 'rounds-exhausted',
              baseSha: 'x',
              lastReviewedSha: null,
              updatedAt: '2026-09-20T00:00:00Z',
            }
          : null,
      list: () => [],
    });
    const workingRun = await h.orchestrator.dispatch(working, 'fake');
    const reviewRun = await h.orchestrator.dispatchAuxRun({
      taskId: reviewing,
      kind: 'review',
      head: 'HEAD',
      executor: 'fake',
      buildPrompt: () => 'review',
    });
    await waitFor(() => awaiting(h, [working, reviewing]).length === 2);

    const progress = h.epics.progress(epic.meta.id);
    expect(progress.session).toBeNull();
    expect(progress.active).toBe(false);
    const byId = new Map(progress.children.map((c) => [c.id, c]));
    expect(byId.get(working)).toMatchObject({
      phase: 'working',
      wave: 1,
      runId: workingRun.id,
      openFindings: 0,
    });
    expect(byId.get(held)).toMatchObject({ phase: 'held', wave: 1 });
    expect(byId.get(waiting)).toMatchObject({
      phase: 'waiting',
      wave: 2,
      reason: `waiting on ${working}`,
    });
    expect(byId.get(third)).toMatchObject({ phase: 'waiting', wave: 3 });
    expect(byId.get(queued)).toMatchObject({ phase: 'queued', wave: 1 });
    expect(byId.get(reviewing)).toMatchObject({
      phase: 'reviewing',
      runId: reviewRun.id,
    });
    expect(byId.get(capped)).toMatchObject({
      phase: 'capped',
      reason: 'needs a ruling',
    });
    expect(byId.get(landed)?.phase).toBe('landed');
    expect(byId.get(needsReview)?.phase).toBe('needs-review');
    expect(byId.get(draft)?.phase).toBe('draft');
    expect(progress.waves.map((w) => w.index)).toEqual([1, 2, 3]);
    // No session: spend covers every child run.
    expect(progress.spend).toMatchObject({
      liveCount: 2,
      runsStarted: 2,
      maxSpendUsd: null,
      maxRuns: null,
    });
    expect(progress.liveRuns).toHaveLength(2);
  });

  it('progressAll covers every non-archived epic in id order', () => {
    const h = makeHarness();
    const a = createEpicWithChildren(h.store, 1);
    const b = createEpicWithChildren(h.store, 2);
    const archived = h.store.create({ title: 'Old', kind: 'epic' });
    h.store.update(archived.meta.id, {
      status: 'landed',
      archivedAt: '2026-09-01T00:00:00Z',
    });
    h.cache.rebuild(h.store);

    const all = h.epics.progressAll();
    expect(all.map((p) => p.epicId)).toEqual([a.epicId, b.epicId].sort());
    expect(all.find((p) => p.epicId === b.epicId)?.children).toHaveLength(2);
  });
});
