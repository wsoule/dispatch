import { ActorContext, fanoutScope, TaskStore } from '@dispatch/core';
import type { CreateInput } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { EpicEngine } from '../../src/orchestrator/epic.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { epicSessionsPath } from '../../src/orchestrator/paths.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync, WatchedTaskStore } from './helpers.js';

// Who a fan-out may pick up (never a teammate's task) and what it covers (a
// project's milestone issues, exactly as its Flight Plan draws them).

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-epic-scope-');
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

// The daemon's local human resolves to `human:test` from this git identity.
const gitReader = (args: string[]): string =>
  args.includes('user.email') ? 'test@example.com' : 'Test';

// Every run parks at an approval gate, so live runs stay live until approved.
function makeHarness() {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const actorContext = ActorContext.resolve(repo, gitReader);
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
    actorContext,
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
    actorContext,
    eventDebounceMs: 0,
  });
  const watched = new WatchedTaskStore(repo, cache);
  // A distinct write-set per task, so claims never serialize these tests.
  const task = (title: string, input: Partial<CreateInput> = {}): string =>
    watched.create({ title, kind: 'task', writes: [`${title}.ts`], ...input })
      .meta.id;
  const dispatched = () =>
    new Set(orchestrator.list().map((run) => run.taskId));
  return {
    orchestrator,
    epics,
    store: watched,
    cache,
    events,
    actorContext,
    task,
    dispatched,
  };
}

describe('a fan-out never picks up a teammate’s task', () => {
  it('dispatches unassigned, agent and the starter’s own work only (single-user daemon)', async () => {
    const h = makeHarness();
    expect(h.actorContext.humanRef).toBe('human:test');
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const ids = {
      unassigned: h.task('unassigned', { parent: m }),
      agent: h.task('agent', { parent: m, assignee: 'agent:claude' }),
      mine: h.task('mine', { parent: m, assignee: 'human:test' }),
      legacyMine: h.task('legacy', { parent: m, assignee: 'human' }),
      samTask: h.task('samTask', { parent: m, assignee: 'human:sam' }),
      samAgent: h.task('sam-agent', {
        parent: m,
        assignee: 'agent:sam/claude',
      }),
    };
    const samBefore = h.store.get(ids.samTask);

    const session = await h.epics.start(m, {
      executor: 'fake',
      concurrency: 8,
    });
    expect(session.startedBy).toBe('human:test');
    await waitFor(() => h.orchestrator.list().length === 4);
    await sleep(50);

    expect(h.dispatched()).toEqual(
      new Set([ids.unassigned, ids.agent, ids.mine, ids.legacyMine])
    );
    // Every run is the starter's, though no one pressed dispatch on it.
    expect(new Set(h.orchestrator.list().map((r) => r.dispatchedBy))).toEqual(
      new Set(['human:test'])
    );
    // Untouched: no dispatched status, so nothing for Linear to push.
    const samAfter = h.store.get(ids.samTask);
    expect(samAfter?.meta.status).toBe(samBefore?.meta.status);
    expect(samAfter?.meta.updated).toBe(samBefore?.meta.updated);
    expect(samAfter?.body).toBe(samBefore?.body);

    const phases = new Map(h.epics.progress(m).children.map((c) => [c.id, c]));
    expect(phases.get(ids.samTask)).toMatchObject({
      phase: 'held',
      reason: 'assigned to human:sam',
    });
    expect(phases.get(ids.samAgent)).toMatchObject({
      phase: 'held',
      reason: 'assigned to human:sam',
    });
  });

  it('works for whoever started it on a shared daemon, bare human included', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const ids = {
      unassigned: h.task('unassigned', { parent: m }),
      ada: h.task('ada', { parent: m, assignee: 'human:ada' }),
      operator: h.task('operator', { parent: m, assignee: 'human:test' }),
      bare: h.task('bare', { parent: m, assignee: 'human' }),
    };

    const session = await h.epics.start(m, {
      executor: 'fake',
      concurrency: 8,
      startedBy: 'human:ada',
    });
    expect(session.startedBy).toBe('human:ada');
    await waitFor(() => h.orchestrator.list().length === 2);
    await sleep(50);

    // Bare `human` is the daemon's operator, a teammate from Ada's side.
    expect(h.dispatched()).toEqual(new Set([ids.unassigned, ids.ada]));
    // Ada's runs, not the operator's: another window's "me" lane skips them.
    expect(new Set(h.orchestrator.list().map((r) => r.dispatchedBy))).toEqual(
      new Set(['human:ada'])
    );
    const phases = new Map(h.epics.progress(m).children.map((c) => [c.id, c]));
    expect(phases.get(ids.operator)?.reason).toBe('assigned to human:test');
    expect(phases.get(ids.bare)?.reason).toBe('assigned to human:test');
  });

  it('holds a teammate’s blocker’s dependents until it lands, then starts them', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const samTask = h.task('samTask', { parent: m, assignee: 'human:sam' });
    const dependent = h.task('dependent', { parent: m, blockedBy: [samTask] });

    await h.epics.start(m, { executor: 'fake', concurrency: 4 });
    await sleep(50);
    expect(h.orchestrator.list()).toHaveLength(0);
    expect(h.epics.progress(m).session?.state).toBe('active');

    // Sam's issue moves on in Linear; the sync writes it and says so.
    h.store.update(samTask, { status: 'working' });
    h.events.broadcast({ type: 'task.changed', ids: [samTask] });
    await sleep(50);
    expect(h.orchestrator.list()).toHaveLength(0);

    h.store.update(samTask, { status: 'landed' });
    h.events.broadcast({ type: 'task.changed', ids: [samTask] });
    await waitFor(() => h.dispatched().has(dependent));
    expect(h.dispatched()).toEqual(new Set([dependent]));
  });

  it('holds a teammate’s dependents through In Review, with no branch of theirs to stack on', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const samTask = h.task('samTask', { parent: m, assignee: 'human:sam' });
    const dependent = h.task('dependent', { parent: m, blockedBy: [samTask] });
    // Moved to review by hand: no run, so no branch either.
    const handMoved = h.task('handMoved', { parent: m });
    const handDependent = h.task('handDependent', {
      parent: m,
      blockedBy: [handMoved],
    });
    h.store.update(handMoved, { status: 'review' });

    await h.epics.start(m, { executor: 'fake', concurrency: 4 });
    await sleep(50);
    expect(h.orchestrator.list()).toHaveLength(0);

    // Sam opens his PR: Linear moves the issue to In Review.
    h.store.update(samTask, { status: 'review' });
    h.events.broadcast({ type: 'task.changed', ids: [samTask] });
    await sleep(100);
    expect(h.orchestrator.list()).toHaveLength(0);
    const phases = new Map(h.epics.progress(m).children.map((c) => [c.id, c]));
    expect(phases.get(dependent)).toMatchObject({
      phase: 'waiting',
      reason: `waiting on ${samTask}`,
    });
    expect(phases.get(handDependent)).toMatchObject({ phase: 'waiting' });

    h.store.update(samTask, { status: 'landed' });
    h.events.broadcast({ type: 'task.changed', ids: [samTask] });
    await waitFor(() => h.dispatched().has(dependent));
    await sleep(50);
    expect(h.dispatched()).toEqual(new Set([dependent]));
  });

  it('picks up a teammate’s task handed back while nothing runs', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const samTask = h.task('samTask', { parent: m, assignee: 'human:sam' });
    const dependent = h.task('dependent', { parent: m, blockedBy: [samTask] });

    await h.epics.start(m, { executor: 'fake', concurrency: 4 });
    await sleep(50);
    expect(h.orchestrator.list()).toHaveLength(0);

    // Sam hands his issue back in Linear; the pull writes it.
    h.store.update(samTask, { assignee: 'human:test' });
    h.events.broadcast({ type: 'task.changed', ids: [samTask] });
    await waitFor(() => h.dispatched().has(samTask));
    expect(h.dispatched()).toEqual(new Set([samTask]));
    expect(h.dispatched().has(dependent)).toBe(false);
  });

  it('skips a task reassigned to a teammate while the batch is mid-dispatch', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    // Same priority, so the older `first` dispatches first.
    const first = h.task('first', { parent: m });
    await sleep(5);
    const second = h.task('second', { parent: m });
    const secondBefore = h.store.get(second);

    // A Linear pull reassigns `second` while dispatch(first) is still awaiting.
    const original = h.orchestrator.dispatchOrResume.bind(h.orchestrator);
    h.orchestrator.dispatchOrResume = (taskId, request) => {
      const pending = original(taskId, request);
      if (taskId === first) {
        h.store.update(second, { assignee: 'human:sam' });
        h.events.broadcast({ type: 'task.changed', ids: [second] });
      }
      return pending;
    };

    await h.epics.start(m, { executor: 'fake', concurrency: 4 });
    await waitFor(() => h.dispatched().has(first));
    await sleep(50);
    expect(h.dispatched()).toEqual(new Set([first]));
    const secondAfter = h.store.get(second);
    expect(secondAfter?.meta.status).toBe(secondBefore?.meta.status);
    expect(secondAfter?.meta.assignee).toBe('human:sam');
  });

  it('refuses a task reassigned to a teammate during its own dispatch', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const only = h.task('only', { parent: m });
    const original = h.orchestrator.dispatchOrResume.bind(h.orchestrator);
    h.orchestrator.dispatchOrResume = (taskId, request) => {
      const pending = original(taskId, request);
      // Lands after the fill's own checks, before the run registers.
      h.store.update(only, { assignee: 'human:sam' });
      return pending;
    };

    await h.epics.start(m, { executor: 'fake', concurrency: 4 });
    await sleep(50);
    expect(h.orchestrator.list()).toHaveLength(0);
    expect(h.store.get(only)?.meta.status).toBe('ready');
  });

  it('does not complete on a teammate’s leftover task alone', async () => {
    const h = makeHarness();
    const m = h.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
    const mine = h.task('mine', { parent: m });
    h.task('samTask', { parent: m, assignee: 'human:sam' });

    await h.epics.start(m, { executor: 'fake', concurrency: 4 });
    await waitFor(() => h.dispatched().has(mine));
    const run = h.orchestrator.list()[0];
    if (run === undefined) throw new Error('no run');
    h.orchestrator.approve(run.id, 'go', true);
    await waitFor(() => h.epics.progress(m).session?.state === 'complete');
  });
});

describe('a project fans out what its Flight Plan draws', () => {
  // project → { M1 → { a1, parent issue → sub }, M2 → { b1 (blocked by a1) }, direct }
  function project(h: ReturnType<typeof makeHarness>) {
    const p = h.store.create({ title: 'Project', kind: 'project' }).meta.id;
    const m1 = h.store.create({ title: 'M1', kind: 'milestone', parent: p })
      .meta.id;
    const m2 = h.store.create({ title: 'M2', kind: 'milestone', parent: p })
      .meta.id;
    const a1 = h.task('a1', { parent: m1 });
    const parentIssue = h.task('parent-issue', { parent: m1 });
    const sub = h.task('sub', { parent: parentIssue });
    const b1 = h.task('b1', { parent: m2, blockedBy: [a1] });
    const direct = h.task('direct', { parent: p });
    return { p, m1, m2, a1, parentIssue, sub, b1, direct };
  }

  it('dispatches milestone issues across milestones, never a sub-issue, on the P1 branches', async () => {
    const h = makeHarness();
    const t = project(h);
    const planned = fanoutScope(t.p, (id) =>
      h.cache.query({ parent: id, includeArchived: true })
    ).map((c) => c.meta.id);
    expect(new Set(planned)).toEqual(
      new Set([t.a1, t.parentIssue, t.b1, t.direct])
    );
    expect(new Set(h.epics.progress(t.p).children.map((c) => c.id))).toEqual(
      new Set(planned)
    );

    await h.epics.start(t.p, { executor: 'fake', concurrency: 8 });
    await waitFor(() => h.orchestrator.list().length === 2);
    await sleep(50);
    // b1 waits on a1 across milestones; the parent issue is a container.
    expect(h.dispatched()).toEqual(new Set([t.a1, t.direct]));
    const baseOf = (taskId: string) =>
      h.orchestrator.list().find((r) => r.taskId === taskId)?.baseBranch;
    expect(baseOf(t.a1)).toBe(`epic/${t.m1}`);
    expect(baseOf(t.direct)).toBe('main');

    const a1Run = h.orchestrator.list().find((r) => r.taskId === t.a1);
    if (a1Run === undefined) throw new Error('no run for a1');
    h.orchestrator.approve(a1Run.id, 'go', true);
    await waitFor(() => h.dispatched().has(t.b1));
    await sleep(50);
    expect(h.dispatched().has(t.sub)).toBe(false);
    expect(h.dispatched().has(t.parentIssue)).toBe(false);
    // Only milestones and parent issues get integration branches.
    expect(runGitSync(repo, ['branch', '--list', `epic/${t.p}`])).toBe('');
  });

  it('refuses a fan-out that overlaps a live one, either way round', async () => {
    const h = makeHarness();
    const t = project(h);
    await h.epics.start(t.p, { executor: 'fake', concurrency: 1 });
    await expect(
      h.epics.start(t.m1, { executor: 'fake', concurrency: 1 })
    ).rejects.toThrow(OrchestratorConflictError);
    // A parent issue's sub-issues are outside the project's scope.
    await h.epics.start(t.parentIssue, { executor: 'fake', concurrency: 1 });

    h.epics.stop(t.p);
    await h.epics.start(t.m1, { executor: 'fake', concurrency: 1 });
    h.epics.pause(t.m1);
    await expect(
      h.epics.start(t.p, { executor: 'fake', concurrency: 1 })
    ).rejects.toThrow(/overlap .*paused session on 2 task/);
  });
});

// A session as a daemon from before startedBy and plan-wide scopes wrote it.
const LEGACY_SESSION = {
  concurrency: 4,
  executor: 'fake',
  state: 'active',
  maxSpendUsd: null,
  maxRuns: null,
  startedAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
  heldCritical: [],
};

// A daemon booting on `sessions` as persisted, whose sessions arm at once.
function bootWith(sessions: Record<string, unknown>) {
  mkdirSync(join(epicSessionsPath(repo), '..'), { recursive: true });
  writeFileSync(
    epicSessionsPath(repo),
    JSON.stringify({ version: 1, sessions })
  );
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const actorContext = ActorContext.resolve(repo, gitReader);
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
    actorContext,
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
    actorContext,
    resumeDelayMs: 0,
    eventDebounceMs: 0,
  });
  return { orchestrator, epics };
}

it('a session persisted without a starter works for the local human', async () => {
  const h0 = makeHarness();
  const m = h0.store.create({ title: 'Milestone', kind: 'milestone' }).meta.id;
  const mine = h0.task('mine', { parent: m, assignee: 'human:test' });
  h0.task('samTask', { parent: m, assignee: 'human:sam' });
  const { orchestrator, epics } = bootWith({ [m]: LEGACY_SESSION });
  expect(epics.progress(m).session?.startedBy).toBeNull();
  expect(epics.resumeOnBoot()).toBe(1);
  await waitFor(() => orchestrator.list().length === 1);
  await sleep(50);
  expect(orchestrator.list().map((r) => r.taskId)).toEqual([mine]);
  expect(orchestrator.list()[0]?.dispatchedBy).toBe('human:test');
});

it('a project session persisted before plan-wide fan-outs keeps to its direct issues', async () => {
  const h0 = makeHarness();
  const p = h0.store.create({ title: 'Project', kind: 'project' }).meta.id;
  const m = h0.store.create({ title: 'M', kind: 'milestone', parent: p }).meta
    .id;
  const direct = h0.task('direct', { parent: p });
  const underM = h0.task('underM', { parent: m });
  const { orchestrator, epics } = bootWith({ [p]: LEGACY_SESSION });
  expect(epics.progress(p).session?.scope).toBe('direct');
  expect(epics.progress(p).children.map((c) => c.id)).toEqual([direct]);

  epics.resumeOnBoot();
  await waitFor(() => orchestrator.list().length === 1);
  await sleep(100);
  expect(orchestrator.list().map((r) => r.taskId)).toEqual([direct]);

  // The milestone shares no task with it, so it may fan out beside it, and
  // its run is no part of the project session's spend.
  await epics.start(m, { executor: 'fake', concurrency: 1 });
  expect(epics.progress(m).session?.scope).toBe('plan');
  await waitFor(() => orchestrator.list().length === 2);
  expect(orchestrator.list().some((r) => r.taskId === underM)).toBe(true);
  expect(epics.progress(p).spend.runsStarted).toBe(1);

  // Stopped, the project's next fan-out covers its whole plan again.
  epics.stop(p);
  epics.stop(m);
  expect(new Set(epics.progress(p).children.map((c) => c.id))).toEqual(
    new Set([direct, underM])
  );
  expect((await epics.start(p, { executor: 'fake' })).scope).toBe('plan');
});
