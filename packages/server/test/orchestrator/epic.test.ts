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
  it('404s starting an unknown epic', async () => {
    const { epics } = makeHarness();
    await expect(epics.start('e-000000')).rejects.toThrow(
      OrchestratorNotFoundError
    );
  });

  it('400s starting a task id that is not an epic', async () => {
    const { epics, store } = makeHarness();
    const task = store.create({ title: 'Not an epic', kind: 'task' });
    await expect(epics.start(task.meta.id)).rejects.toThrow(
      OrchestratorClientError
    );
  });

  it('400s an invalid explicit concurrency', async () => {
    const { epics, store } = makeHarness();
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    await expect(epics.start(epic.meta.id, { concurrency: 0 })).rejects.toThrow(
      OrchestratorClientError
    );
  });

  it('409s starting an epic that already has an active session', async () => {
    const { epics, store } = makeHarness();
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    await epics.start(epic.meta.id, { executor: 'fake' });
    await expect(
      epics.start(epic.meta.id, { executor: 'fake' })
    ).rejects.toThrow(OrchestratorConflictError);
  });

  // C2(a): a bogus executor must 400 before any session is ever created —
  // and, critically, must NOT leave a half-created session wedged in place
  // that would 409 a subsequent, correctly-specified retry.
  it('400s a bogus executor without wedging the session for a later valid retry', async () => {
    const { epics, store } = makeHarness();
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    await expect(
      epics.start(epic.meta.id, { executor: 'not-a-real-executor' })
    ).rejects.toThrow(OrchestratorClientError);

    // No wedge: retrying with a real executor must succeed, not 409.
    const session = await epics.start(epic.meta.id, { executor: 'fake' });
    expect(session.active).toBe(true);
  });

  // C2(a): if the initial fillQueue() call itself throws (a real, unexpected
  // error — not the OrchestratorConflictError race fillQueue already
  // tolerates), the just-created session must be rolled back so a retry
  // isn't blocked by "already has an active session". Forces a real
  // dispatch()-path failure (git worktree creation) by stripping all
  // permissions off `.git` — a plain Error `WorktreeManager.add()` throws,
  // uncaught by fillQueue's own (narrower) OrchestratorConflictError catch.
  it('rolls back the session when the initial fillQueue throws, so a retry can succeed', async () => {
    const { epics, store } = makeHarness();
    const { epicId } = createEpicWithChildren(store, 1);
    const gitDir = join(repo, '.git');
    Bun.spawnSync(['chmod', '-R', '000', gitDir]);
    try {
      await expect(epics.start(epicId, { executor: 'fake' })).rejects.toThrow();
    } finally {
      Bun.spawnSync(['chmod', '-R', '755', gitDir]);
    }

    const session = await epics.start(epicId, { executor: 'fake' });
    expect(session.active).toBe(true);
  });

  it('dispatches up to the concurrency cap and never exceeds it across 5 ready children with limit 2', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 5);
    const childSet = new Set(childIds);

    await harness.epics.start(epicId, { concurrency: 2, executor: 'fake' });

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

    await harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });

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

  // I3 (adjudicated): discarding a run returns its task to `todo`, but that
  // must NOT be read by the active session as "newly ready" — a discard
  // means a human judged the work wrong, and auto-re-dispatching the exact
  // same prompt would just burn budget repeating the same mistake. The task
  // stays in the ready queue for a human or a future session to explicitly
  // pick up again. Uses two independent children under concurrency 2 so the
  // session stays active (child B still live) at the moment child A is
  // discarded — a single-child epic would otherwise auto-complete (and
  // deactivate) the instant its one run finishes, before discard ever runs,
  // masking whether the *discard-specific* cascade gate actually works.
  it('does not auto-re-dispatch a discarded child while the session is active', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 2);
    const [aId] = childIds;

    await harness.epics.start(epicId, { concurrency: 2, executor: 'fake' });
    await waitFor(() => harness.orchestrator.list().length === 2);
    const runA = harness.orchestrator.list().find((r) => r.taskId === aId)!;
    harness.orchestrator.approve(runA.id, 'go', true);
    await waitFor(() => harness.store.get(aId)?.meta.status === 'in-review');

    expect(harness.epics.progress(epicId).active).toBe(true);
    harness.orchestrator.review(runA.id, 'discard');

    // Give the (buggy, pre-fix) synchronous cascade a moment to land before
    // asserting the final state: with the bug present, the task flashes
    // through 'todo' straight into a re-dispatched 'in-progress' inside
    // review()'s own hook-firing call, before this line even runs — so the
    // meaningful assertion is the *settled* state, not an intermediate one.
    await sleep(80);
    expect(harness.store.get(aId)?.meta.status).toBe('todo');
    const runsForA = harness.orchestrator
      .list()
      .filter((r) => r.taskId === aId);
    expect(runsForA).toHaveLength(1);
    expect(runsForA[0].id).toBe(runA.id);
  });

  // C1: readyTasks(children) alone treats a blocker id outside the passed
  // array as satisfied (dangling ids never block, per core's own readyTasks
  // doc comment) — which would silently ignore a blocker that genuinely
  // exists elsewhere in the project (just not as a sibling child) and let
  // the dependent dispatch immediately. Readiness must be computed over the
  // FULL task set and only then intersected with the epic's children — the
  // initial "still todo after start()" assertion below is what actually
  // catches a regression back to computing readiness over `children` only.
  //
  // No review/merge call happens in this test on purpose: EpicEngine now
  // dispatches on dispatchableTasks (isSatisfiedForDispatch), so the outside
  // blocker only needs to reach `in-review` to unblock the child, and the
  // dispatch assertion below fires strictly before any merge could — that's
  // what makes it discriminate the in-review path rather than passing for a
  // reason unrelated to what the test name claims.
  it('dispatches a child blocked by an outside (non-sibling) task once that task reaches in-review, without a merge', async () => {
    const harness = makeHarness();
    const outside = harness.store.create({ title: 'Outside blocker' });
    const { epicId, childIds } = createEpicWithChildren(
      harness.store,
      1,
      () => [outside.meta.id]
    );
    harness.cache.rebuild(harness.store);

    await harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
    await sleep(60);
    expect(harness.orchestrator.list()).toHaveLength(0);
    expect(harness.store.get(childIds[0])?.meta.status).toBe('todo');

    // Drive the outside blocker (unrelated to any epic) to a terminal run
    // state -> its task becomes `in-review`. That alone must cascade-dispatch
    // the now-unblocked child.
    const outsideRun = await harness.orchestrator.dispatch(
      outside.meta.id,
      'fake'
    );
    await waitFor(() =>
      harness.orchestrator
        .list()
        .some((r) => r.id === outsideRun.id && r.state === 'awaiting-approval')
    );
    harness.orchestrator.approve(outsideRun.id, 'go', true);

    await waitFor(() =>
      harness.orchestrator
        .list()
        .some(
          (r) => r.taskId === childIds[0] && r.state === 'awaiting-approval'
        )
    );
    // The outside blocker is still merely `in-review` — no merge/PR-merge
    // ever ran — confirming dispatch didn't secretly wait on one.
    expect(harness.store.get(outside.meta.id)?.meta.status).toBe('in-review');
  });

  // The behavioral fix under test: a dependent must dispatch as soon as its
  // blocker's run finishes and the blocker lands at `in-review` — it must
  // NOT wait for a human to merge the blocker all the way to `done`. This
  // exercises EpicEngine.fillQueue's switch from readyTasks (gates on
  // isDone) to dispatchableTasks (gates on isSatisfiedForDispatch, which
  // also accepts `in-review`).
  it('dispatches a child whose blocker is only in-review, not yet done', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'Epic', kind: 'epic' });
    const blocker = h.store.create({ title: 'A', parent: epic.meta.id });
    const dependent = h.store.create({
      title: 'B',
      parent: epic.meta.id,
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    await h.epics.start(epic.meta.id, { concurrency: 2, executor: 'fake' });

    // Only the blocker is dispatchable at first.
    await waitFor(() => h.orchestrator.list().length === 1);
    expect(h.orchestrator.list()[0].taskId).toBe(blocker.meta.id);

    // Drive the blocker to a terminal state -> task becomes `in-review`.
    const run = h.orchestrator.list()[0];
    h.orchestrator.approve(run.id, 'go', true);
    await waitFor(
      () => h.store.get(blocker.meta.id)!.meta.status === 'in-review'
    );

    // The dependent must now dispatch WITHOUT the blocker ever reaching `done`.
    await waitFor(() =>
      h.orchestrator.list().some((r) => r.taskId === dependent.meta.id)
    );
    expect(h.store.get(blocker.meta.id)!.meta.status).toBe('in-review');
  });

  // Guard against over-loosening the fix above: a blocker that is merely
  // `in-progress` (its run hasn't reached a terminal state yet) must not
  // satisfy dispatch-readiness — only in-review/done/cancelled do.
  it('does not dispatch a child whose blocker is still in-progress', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'Epic', kind: 'epic' });
    const blocker = h.store.create({ title: 'A', parent: epic.meta.id });
    const dependent = h.store.create({
      title: 'B',
      parent: epic.meta.id,
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    await h.epics.start(epic.meta.id, { concurrency: 2, executor: 'fake' });
    await waitFor(() => h.orchestrator.list().length === 1);
    await sleep(50); // give a wrong implementation time to dispatch the dependent

    expect(h.store.get(blocker.meta.id)!.meta.status).toBe('in-progress');
    expect(
      h.orchestrator.list().some((r) => r.taskId === dependent.meta.id)
    ).toBe(false);
  });

  it('stop halts new dispatches while letting the live run finish', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 2);
    const [firstId, secondId] = childIds;

    await harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
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

    await harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
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
      return body.includes('epic dispatch session ended');
    });
    const epicDoc = harness.store.get(epicId);
    expect(epicDoc?.body).toContain('epic dispatch started');
    expect(epicDoc?.body).toContain('epic dispatch session ended');
    expect(harness.epics.progress(epicId).active).toBe(false);
  });

  it('progress reports children grouped by status and current live runs', async () => {
    const harness = makeHarness();
    const { epicId, childIds } = createEpicWithChildren(harness.store, 2);

    await harness.epics.start(epicId, { concurrency: 1, executor: 'fake' });
    await waitFor(() => harness.orchestrator.list().length === 1);

    const progress = harness.epics.progress(epicId);
    expect(progress.children).toHaveLength(2);
    expect(progress.liveRuns).toHaveLength(1);
    expect(progress.active).toBe(true);
    expect(progress.concurrency).toBe(1);
    void childIds;
  });
});
