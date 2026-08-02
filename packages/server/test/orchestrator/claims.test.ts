import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
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

function makeOrchestrator(rootDir: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
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
});
