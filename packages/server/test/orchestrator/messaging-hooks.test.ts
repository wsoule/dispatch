import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo, StallingExecutor } from './helpers.js';

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

function makeOrchestrator(rootDir: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    events: new EventBus(),
  });
  return { orchestrator, store };
}

describe('Orchestrator messaging hooks', () => {
  it('mints a run token at start and fires onRunStarted', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const task = store.create({ title: 'Task' });

    orchestrator.setRunTokenMinter((id) => `${id}.tok`);
    const started: string[] = [];
    orchestrator.onRunStarted((m) => started.push(m.id));

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');

    expect(started).toEqual([meta.id]);
    expect(executor.lastStartOptions?.runToken).toBe(`${meta.id}.tok`);
    expect(orchestrator.liveRunIdForTask(task.meta.id)).toBe(meta.id);
    expect(orchestrator.taskIdOfRun(meta.id)).toBe(task.meta.id);
    expect(orchestrator.isRunLive(meta.id)).toBe(true);
  });

  it('deliverToRun sends and logs; notifyRun notes and logs', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const task = store.create({ title: 'Task' });

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');
    orchestrator.deliverToRun(
      meta.id,
      '[message from human:wyat · message · m-1]\nhi',
      { label: 'human:wyat', messageId: 'm-1', human: true }
    );
    orchestrator.notifyRun(meta.id, '📬 digest');

    expect(executor.sent).toEqual([
      '[message from human:wyat · message · m-1]\nhi',
    ]);
    expect(executor.notified).toEqual(['📬 digest']);
  });

  it('refuses delivery to a finished run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const task = store.create({ title: 'Task' });

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');
    await orchestrator.cancel(meta.id);

    expect(() =>
      orchestrator.deliverToRun(meta.id, 'x', {
        label: 'a',
        messageId: 'm',
        human: false,
      })
    ).toThrow();
    expect(() => orchestrator.notifyRun(meta.id, 'x')).toThrow();
    expect(orchestrator.isRunLive(meta.id)).toBe(false);
    expect(orchestrator.liveRunIdForTask(task.meta.id)).toBeNull();
  });
});
