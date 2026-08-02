import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { GitRepo } from '../../src/git/commands.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo();
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeOrchestrator(
  rootDir: string,
  opts: { claimsRefreshCooldownMs?: number } = {}
): {
  orchestrator: Orchestrator;
  store: TaskStore;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    events,
    claimsRefreshCooldownMs: opts.claimsRefreshCooldownMs,
  });
  return { orchestrator, store };
}

describe('run claims', () => {
  it("seeds a run's claims from its task's declared writes", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', costUsd: 0, turns: 1 } })
    );
    const task = store.create({ title: 'Task', writes: ['a.ts', 'b.ts'] });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.claims).toEqual(['a.ts', 'b.ts']);
  });

  it('grows claims from the worktree git status beyond the declared writes', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => writeFileSync(join(cwd, 'extra.ts'), 'x'),
            commit: false,
            approval: { requestId: 'go', toolName: 'noop', input: {} },
          },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const task = store.create({ title: 'Task', writes: ['a.ts'] });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () =>
        orchestrator.list().find((r) => r.id === meta.id)?.state ===
        'awaiting-approval'
    );

    await orchestrator.refreshClaims(meta.id);

    const grown = orchestrator.list().find((r) => r.id === meta.id);
    expect(grown?.claims).toEqual(['a.ts', 'extra.ts']);
  });

  it('clears a run from liveClaims once it reaches a terminal state', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'go', toolName: 'noop', input: {} } }],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const task = store.create({ title: 'Task', writes: ['a.ts'] });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () =>
        orchestrator.list().find((r) => r.id === meta.id)?.state ===
        'awaiting-approval'
    );
    expect(orchestrator.liveClaims().some((c) => c.runId === meta.id)).toBe(
      true
    );

    orchestrator.approve(meta.id, 'go', true);
    await waitFor(
      () =>
        orchestrator.list().find((r) => r.id === meta.id)?.state === 'finished'
    );

    expect(orchestrator.liveClaims().some((c) => c.runId === meta.id)).toBe(
      false
    );
  });

  // Every other growth test calls refreshClaims() directly; this one drives
  // growth through the real onEntry trigger and checks the cooldown itself.
  it('grows claims via the real onEntry trigger, and the cooldown suppresses a second refresh', async () => {
    // A cooldown far longer than this test takes keeps the second entry
    // below unambiguously inside the window, so suppression isn't a race.
    const { orchestrator, store } = makeOrchestrator(repo, {
      claimsRefreshCooldownMs: 60_000,
    });
    let statusCalls = 0;
    const originalStatus = GitRepo.prototype.status;
    GitRepo.prototype.status = async function (this: GitRepo) {
      statusCalls++;
      return originalStatus.call(this);
    };

    try {
      orchestrator.registerExecutor(
        'fake',
        new FakeExecutor({
          steps: [
            {
              write: (cwd) => writeFileSync(join(cwd, 'first.ts'), 'x'),
              commit: false,
            },
            {
              entry: {
                ts: new Date().toISOString(),
                kind: 'assistant',
                text: 'wrote first.ts',
              },
            },
            {
              write: (cwd) => writeFileSync(join(cwd, 'second.ts'), 'x'),
              commit: false,
            },
            {
              entry: {
                ts: new Date().toISOString(),
                kind: 'assistant',
                text: 'wrote second.ts',
              },
            },
            // Keeps the run 'running' long enough to assert against, with
            // no idle-transition of its own; cancel() below stops it early.
            { delayMs: 300 },
          ],
          finish: { state: 'finished', costUsd: 0, turns: 1 },
        })
      );
      const task = store.create({ title: 'Task', writes: ['a.ts'] });
      const meta = await orchestrator.dispatch(task.meta.id, 'fake');

      // Short timeout, inside the 300ms delay: only onEntry can satisfy this
      // before an idle transition's own forced refresh could confound it.
      await waitFor(
        () =>
          (
            orchestrator.list().find((r) => r.id === meta.id)?.claims ?? []
          ).includes('first.ts'),
        150
      );
      expect(orchestrator.list().find((r) => r.id === meta.id)?.state).toBe(
        'running'
      );
      expect(statusCalls).toBe(1);

      await orchestrator.cancel(meta.id);
    } finally {
      GitRepo.prototype.status = originalStatus;
    }
  });

  // Pins the cancel() call site: no entry or approval ever fires, so only
  // cancel()'s own forced refresh can see this test's direct worktree write.
  it('captures a trailing edit on cancel, with no other trigger in play', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ delayMs: 2000 }],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const task = store.create({ title: 'Task', writes: ['a.ts'] });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () =>
        orchestrator.list().find((r) => r.id === meta.id)?.state === 'running'
    );

    writeFileSync(join(meta.worktreePath, 'trailing.ts'), 'x');
    await orchestrator.cancel(meta.id);

    await waitFor(() =>
      (
        orchestrator.list().find((r) => r.id === meta.id)?.claims ?? []
      ).includes('trailing.ts')
    );
  });

  // Pins the onApprovalRequest call site: no entry ever fires, so only the
  // forced refresh at the approval transition can see the write.
  it('captures a trailing edit on the approval transition, with no entry in play', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => writeFileSync(join(cwd, 'trailing.ts'), 'x'),
            commit: false,
            approval: { requestId: 'go', toolName: 'noop', input: {} },
          },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const task = store.create({ title: 'Task', writes: ['a.ts'] });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(() =>
      (
        orchestrator.list().find((r) => r.id === meta.id)?.claims ?? []
      ).includes('trailing.ts')
    );
    expect(orchestrator.list().find((r) => r.id === meta.id)?.state).toBe(
      'awaiting-approval'
    );
  });

  // Pins the handleFinish call site: no entry or approval ever fires, so
  // only the forced refresh right before the terminal transition can see it.
  it('captures a trailing edit on finish, with no other trigger in play', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => writeFileSync(join(cwd, 'trailing.ts'), 'x'),
            commit: false,
          },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const task = store.create({ title: 'Task', writes: ['a.ts'] });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(() =>
      (
        orchestrator.list().find((r) => r.id === meta.id)?.claims ?? []
      ).includes('trailing.ts')
    );
  });
});
