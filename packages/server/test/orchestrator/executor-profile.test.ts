import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  DEFAULT_EXECUTOR_PROFILE,
  OrchestratorClientError,
} from '../../src/orchestrator/types.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorProfile,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { initGitRepo, StallingExecutor } from './helpers.js';

let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  process.env.DISPATCH_HOME = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  repo = initGitRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

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

function writeConfig(rootDir: string, yaml: string): void {
  mkdirSync(join(rootDir, '.dispatch'), { recursive: true });
  writeFileSync(join(rootDir, '.dispatch/config.yml'), yaml);
}

// Finishes immediately with whatever `finish` says, so the finish line can be
// inspected for executors that do and do not report cost.
function finishingExecutor(finish: {
  state: 'finished';
  costUsd?: number;
  turns?: number;
}): Executor {
  return {
    start(_opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
      queueMicrotask(() => events.onFinish(finish));
      return {
        interrupt: () => Promise.resolve(),
        requestStop: () => {},
        send: () => {},
        approve: () => {},
        notify: () => {},
      };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

describe('executor profiles', () => {
  it('refuses a dispatch the profile cannot run under the configured permission mode, before any run exists', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    writeConfig(repo, 'orchestrator:\n  permissionMode: auto\n');
    const profile: ExecutorProfile = {
      ...DEFAULT_EXECUTOR_PROFILE,
      permissionRefusal: (mode) => (mode === 'auto' ? 'no auto here' : null),
    };
    const picky = new StallingExecutor();
    orchestrator.registerExecutor('picky', Object.assign(picky, { profile }));
    const task = store.create({ title: 'Picky' });

    await expect(orchestrator.dispatch(task.meta.id, 'picky')).rejects.toThrow(
      OrchestratorClientError
    );
    await expect(orchestrator.dispatch(task.meta.id, 'picky')).rejects.toThrow(
      /no auto here/
    );
    expect(orchestrator.list()).toEqual([]);
    expect(picky.started).toEqual([]);
  });

  it('defaultExecutorName follows orchestrator.executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('claude', new StallingExecutor());
    orchestrator.registerExecutor('codex', new StallingExecutor());
    expect(orchestrator.defaultExecutorName()).toBe('claude');

    writeConfig(repo, 'orchestrator:\n  executor: codex\n');
    expect(orchestrator.defaultExecutorName()).toBe('codex');
    const task = store.create({ title: 'Default executor' });
    const meta = await orchestrator.dispatchOrResume(task.meta.id);
    expect(meta.executor).toBe('codex');
  });

  it('executorForTask names the newest execute run, else the default', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('claude', new StallingExecutor());
    orchestrator.registerExecutor('codex', new StallingExecutor());
    const task = store.create({ title: 'Inherit' });
    expect(orchestrator.executorForTask(task.meta.id)).toBe('claude');

    await orchestrator.dispatch(task.meta.id, 'codex');
    expect(orchestrator.executorForTask(task.meta.id)).toBe('codex');
  });

  it('executorProfile falls back to the default profile', () => {
    const { orchestrator } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ steps: [], finish: { state: 'finished' } })
    );
    expect(orchestrator.executorProfile('fake')).toBe(DEFAULT_EXECUTOR_PROFILE);
    expect(orchestrator.executorProfile('missing')).toBe(
      DEFAULT_EXECUTOR_PROFILE
    );
  });

  it('the finish line says "cost n/a" when the executor reported none', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'silent',
      finishingExecutor({ state: 'finished', turns: 1 })
    );
    orchestrator.registerExecutor(
      'priced',
      finishingExecutor({ state: 'finished', costUsd: 1.5, turns: 3 })
    );

    const silent = store.create({ title: 'Silent' });
    const silentMeta = await orchestrator.dispatch(silent.meta.id, 'silent');
    await waitFor(
      () => orchestrator.getRun(silentMeta.id)?.meta.state === 'finished'
    );
    expect(store.get(silent.meta.id)!.body).toContain(
      `[run ${silentMeta.id}] finished: finished — 0 files, cost n/a`
    );

    const priced = store.create({ title: 'Priced' });
    const pricedMeta = await orchestrator.dispatch(priced.meta.id, 'priced');
    await waitFor(
      () => orchestrator.getRun(pricedMeta.id)?.meta.state === 'finished'
    );
    expect(store.get(priced.meta.id)!.body).toContain(
      `[run ${pricedMeta.id}] finished: finished — 0 files, $1.50`
    );
  });
});
