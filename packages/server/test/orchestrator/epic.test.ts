import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { EpicEngine } from '../../src/orchestrator/epic.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-epic-');
});

afterEach(() => {
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
}

// Registers a 'fake' executor whose script pauses at a fixed approval gate
// before finishing — every dispatched run reaches `awaiting-approval` almost
// immediately and stays there until the test calls orchestrator.approve(),
// which is exactly the timing control the concurrency tests below need: the
// number of runs sitting in `awaiting-approval` at any moment IS the number
// of live slots the epic engine currently has open.
function makeHarness(): Harness {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
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
      finish: { state: 'finished', costUsd: 0, turns: 1 },
    })
  );
  const epics = new EpicEngine({
    rootDir: repo,
    store,
    cache,
    events,
    orchestrator,
  });
  return { orchestrator, epics, store, cache, events };
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
    });
    childIds.push(doc.meta.id);
  }
  childIds.forEach((id, i) => {
    const deps = blockedBy(i, childIds);
    if (deps.length > 0) store.update(id, { blockedBy: deps });
  });
  return { epicId: epic.meta.id, childIds };
}

describe('EpicEngine.start', () => {
  it('404s starting an unknown epic', () => {
    const { epics } = makeHarness();
    expect(() => epics.start('e-000000')).toThrow(OrchestratorNotFoundError);
  });

  it('400s starting a task id that is not an epic', () => {
    const { epics, store } = makeHarness();
    const task = store.create({ title: 'Not an epic', kind: 'task' });
    expect(() => epics.start(task.meta.id)).toThrow(OrchestratorClientError);
  });

  it('400s an invalid explicit concurrency', () => {
    const { epics, store } = makeHarness();
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    expect(() => epics.start(epic.meta.id, { concurrency: 0 })).toThrow(
      OrchestratorClientError
    );
  });

  it('409s starting an epic that already has an active session', () => {
    const { epics, store } = makeHarness();
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    epics.start(epic.meta.id, { executor: 'fake' });
    expect(() => epics.start(epic.meta.id, { executor: 'fake' })).toThrow(
      OrchestratorConflictError
    );
  });

  it('dispatches up to the concurrency cap and never exceeds it across 5 ready children with limit 2', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 5);
    const childSet = new Set(childIds);

    harness.epics.start(epicId, { concurrency: 2, executor: 'fake' });

    await waitFor(
      () =>
        harness.orchestrator
          .list()
          .filter(
            (r) => childSet.has(r.taskId) && r.state === 'awaiting-approval'
          ).length === 2
    );

    // Sample repeatedly while approving runs one at a time — at no point
    // should more than 2 of this epic's children have a live (non-terminal)
    // run at once.
    let maxObserved = 0;
    let finished = 0;
    while (finished < 5) {
      const live = harness.orchestrator
        .list()
        .filter(
          (r) =>
            childSet.has(r.taskId) &&
            r.state !== 'finished' &&
            r.state !== 'failed' &&
            r.state !== 'cancelled'
        );
      maxObserved = Math.max(maxObserved, live.length);

      const awaiting = live.filter((r) => r.state === 'awaiting-approval');
      if (awaiting.length > 0) {
        harness.orchestrator.approve(awaiting[0].id, 'go', true);
        finished++;
        await sleep(15);
      } else {
        await sleep(10);
      }
    }

    expect(maxObserved).toBeLessThanOrEqual(2);
    const doneCount = childIds.filter(
      (id) => harness.store.get(id)?.meta.status === 'done'
    ).length;
    expect(doneCount).toBe(0); // FakeExecutor's finish never merges — status stays in-review
    const inReviewCount = childIds.filter(
      (id) => harness.store.get(id)?.meta.status === 'in-review'
    ).length;
    expect(inReviewCount).toBe(5);
  });

  it('dispatches a newly-unblocked child once its blocker finishes (unblock cascade)', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(
      harness.store,
      2,
      (i, ids) => (i === 1 ? [ids[0]] : [])
    );
    const [blockerId, blockedId] = childIds;

    harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });

    // Only the blocker is ready at first — the blocked sibling must not be
    // dispatched yet.
    await waitFor(
      () =>
        harness.orchestrator
          .list()
          .filter(
            (r) => r.taskId === blockerId && r.state === 'awaiting-approval'
          ).length === 1
    );
    expect(
      harness.orchestrator.list().some((r) => r.taskId === blockedId)
    ).toBe(false);

    const blockerRun = harness.orchestrator
      .list()
      .find((r) => r.taskId === blockerId)!;
    harness.orchestrator.approve(blockerRun.id, 'go', true);
    await waitFor(
      () => harness.store.get(blockerId)?.meta.status === 'in-review'
    );

    // core's readyTasks() gates a blocked task on its blocker being
    // done/cancelled, not merely finished — merging is what actually
    // satisfies that (see Orchestrator.onRunReviewed's doc comment), and is
    // exactly what should cascade-dispatch the now-unblocked sibling.
    harness.orchestrator.review(blockerRun.id, 'merge');
    await waitFor(() =>
      harness.orchestrator
        .list()
        .some((r) => r.taskId === blockedId && r.state === 'awaiting-approval')
    );
    const blockedRun = harness.orchestrator
      .list()
      .find((r) => r.taskId === blockedId)!;
    harness.orchestrator.approve(blockedRun.id, 'go', true);

    // The blocker is 'done' (merged above); the sibling that was blocked on
    // it has now run to completion too, landing at 'in-review'.
    await waitFor(
      () => harness.store.get(blockedId)?.meta.status === 'in-review'
    );
    expect(harness.store.get(blockerId)?.meta.status).toBe('done');
  });

  it('stop halts new dispatches while letting the live run finish', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 2);
    const [firstId, secondId] = childIds;

    harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
    await waitFor(() => harness.orchestrator.list().length === 1);

    const stopped = harness.epics.stop(epicId);
    expect(stopped.active).toBe(false);

    const runningRun = harness.orchestrator.list()[0];
    harness.orchestrator.approve(runningRun.id, 'go', true);

    await waitFor(
      () => harness.store.get(runningRun.taskId)?.meta.status === 'in-review'
    );
    // Give any (incorrect) cascade dispatch a moment to happen before
    // asserting it didn't.
    await sleep(60);
    expect(harness.orchestrator.list().length).toBe(1);
    const untouchedId = runningRun.taskId === firstId ? secondId : firstId;
    expect(harness.store.get(untouchedId)?.meta.status).toBe('todo');
  });

  it('409s stopping an epic with no active session', () => {
    const { epics, store } = makeHarness();
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    expect(() => epics.stop(epic.meta.id)).toThrow(OrchestratorConflictError);
  });

  it('records a completion Activity line once every child has left todo/in-progress', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 1);

    harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
    await waitFor(() => harness.orchestrator.list().length === 1);
    const run = harness.orchestrator.list()[0];
    harness.orchestrator.approve(run.id, 'go', true);

    // The run finishing flips its task from in-progress to in-review, which
    // is enough for the epic engine to consider its dispatch work complete
    // (no human review action required — see isEpicComplete's doc comment).
    await waitFor(
      () => harness.store.get(childIds[0])?.meta.status === 'in-review'
    );
    await waitFor(() => {
      const body = harness.store.get(epicId)?.body ?? '';
      return body.includes('epic dispatch complete');
    });
    const epicDoc = harness.store.get(epicId);
    expect(epicDoc?.body).toContain('epic dispatch started');
    expect(epicDoc?.body).toContain('epic dispatch complete');
    expect(harness.epics.progress(epicId).active).toBe(false);
  });

  it('progress reports children grouped by status and current live runs', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 2);

    harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
    await waitFor(() => harness.orchestrator.list().length === 1);

    const progress = harness.epics.progress(epicId);
    expect(progress.children).toHaveLength(2);
    expect(progress.liveRuns).toHaveLength(1);
    expect(progress.active).toBe(true);
    expect(progress.concurrency).toBe(1);
    void childIds;
  });
});
