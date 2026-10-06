import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

// A held orchestrator starts nothing: the daemon holds it while it restarts
// to turn on team sync, so no run begins in the window before the stop.
let fakeHome: string;
let repo: string;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-hold-');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('Orchestrator.hold', () => {
  it('refuses dispatches and aux runs while held, and starts them once released', async () => {
    const store = TaskStore.init(repo);
    const cache = new TaskCache();
    cache.rebuild(store);
    const orchestrator = new Orchestrator({
      rootDir: repo,
      store,
      cache,
      events: new EventBus(),
      commandRunner: () =>
        Promise.resolve({ ok: true, stdout: '', stderr: '' }),
    });
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', costUsd: 0, turns: 1 } })
    );
    const task = store.create({ title: 'held' });
    orchestrator.hold('Dispatch is restarting');
    await expect(orchestrator.dispatch(task.meta.id, 'fake')).rejects.toThrow(
      OrchestratorConflictError
    );
    expect(() =>
      orchestrator.dispatchAuxRun({
        operator: null,
        taskId: task.meta.id,
        kind: 'verify',
        executor: 'fake',
        head: 'main',
        buildPrompt: () => 'go',
      })
    ).toThrow('Dispatch is restarting');
    expect(orchestrator.list()).toHaveLength(0);
    orchestrator.release();
    const run = await orchestrator.dispatch(task.meta.id, 'fake');
    expect(run.id).not.toBe('');
    orchestrator.shutdown();
  });
});
