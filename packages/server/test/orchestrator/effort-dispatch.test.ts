import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type {
  ExecutorEvents,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

// A run's effort: the caller's pick, else config `effort.execute`, else none.
// Whatever is chosen is recorded on the run and handed to the executor.

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

// A FakeExecutor that remembers the options of every start it receives.
class CapturingExecutor extends FakeExecutor {
  readonly starts: ExecutorStartOptions[] = [];

  override start(
    opts: ExecutorStartOptions,
    events: ExecutorEvents
  ): ReturnType<FakeExecutor['start']> {
    this.starts.push(opts);
    return super.start(opts, events);
  }
}

function setup(config?: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
  executor: CapturingExecutor;
} {
  const store = TaskStore.init(repo);
  if (config !== undefined) {
    writeFileSync(join(repo, '.dispatch', 'config.yml'), config);
  }
  const cache = new TaskCache();
  cache.rebuild(store);
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
  });
  const executor = new CapturingExecutor({
    steps: [],
    finish: { state: 'finished' },
  });
  orchestrator.registerExecutor('claude', executor);
  return { orchestrator, store, executor };
}

describe('run effort', () => {
  it('sends no effort when neither the caller nor config names one', async () => {
    const { orchestrator, store, executor } = setup();
    const task = store.create({ title: 'Add a flag', status: 'ready' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
    });
    expect(meta.effort).toBeUndefined();
    expect('effort' in meta).toBe(false);
    expect(executor.starts[0]?.effort).toBeUndefined();
  });

  it('falls back to config effort.execute', async () => {
    const { orchestrator, store, executor } = setup(
      'effort:\n  execute: xhigh\n'
    );
    const task = store.create({ title: 'Add a flag', status: 'ready' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
    });
    expect(meta.effort).toBe('xhigh');
    expect(executor.starts[0]?.effort).toBe('xhigh');
  });

  it('lets the caller override the configured effort', async () => {
    const { orchestrator, store, executor } = setup(
      'effort:\n  execute: xhigh\n'
    );
    const task = store.create({ title: 'Add a flag', status: 'ready' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
      effort: 'low',
    });
    expect(meta.effort).toBe('low');
    expect(executor.starts[0]?.effort).toBe('low');
  });
});
