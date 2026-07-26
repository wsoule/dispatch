import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-stack-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// The FakeExecutor plays its script fire-and-forget, so a run's terminal
// state lands some ticks after `dispatch()` resolves. Stacking only ever
// considers a blocker's TERMINAL, unreviewed run, so these tests have to
// wait for that to settle before dispatching the dependent.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeHarness() {
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
    new FakeExecutor({ finish: { state: 'finished' } })
  );
  return { store, cache, events, orchestrator };
}

describe('base selection', () => {
  it('uses the default base branch when a task has no blockers', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'solo' });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
    expect(meta.stackBaseCommit).toBeUndefined();
  });

  it('branches off the blocker branch when one blocker is in-review', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A' });
    const blockerRun = await h.orchestrator.dispatch(blocker.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(blockerRun.id)?.meta.state === 'finished'
    );
    // Simulate the blocker finishing: commit work, move task to in-review.
    await Bun.write(join(blockerRun.worktreePath, 'a.txt'), 'a');
    runGitSync(blockerRun.worktreePath, ['add', '-A']);
    runGitSync(blockerRun.worktreePath, ['commit', '-m', 'A work']);
    h.store.update(
      blocker.meta.id,
      { status: 'in-review' },
      new Date().toISOString()
    );
    h.cache.rebuild(h.store);

    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(blockerRun.branch);
    expect(meta.stackParents).toEqual([blockerRun.branch]);
    // stackBaseCommit pins where this run's OWN commits begin.
    expect(meta.stackBaseCommit).toBe(
      runGitSync(repo, ['rev-parse', '--verify', blockerRun.branch]).trim()
    );
    // The dependent's worktree must actually contain the blocker's work.
    expect(await Bun.file(join(meta.worktreePath, 'a.txt')).text()).toBe('a');
  });

  it('falls back to the default base when the blocker is already done', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A', status: 'done' });
    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });

  it('falls back to the default base when an in-review blocker has no run', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A', status: 'in-review' });
    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });
});
