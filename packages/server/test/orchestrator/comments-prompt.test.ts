import { FileCommentStore, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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

// A dispatched run reads the notes earlier runs and teammates left in the
// task's comment thread, the way it used to read them in Activity.

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

it("puts the task's comment thread in the run's prompt", async () => {
  const store = TaskStore.init(repo);
  const comments = new FileCommentStore(repo);
  const cache = new TaskCache();
  const task = store.create({ title: 'Add a flag', status: 'ready' });
  cache.rebuild(store);
  comments.add({
    taskId: task.meta.id,
    author: 'agent',
    body: 'Tried the env var route; the config loader ignores it.',
    parentId: null,
    external: null,
  });
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
    comments,
  });
  const executor = new CapturingExecutor({
    steps: [],
    finish: { state: 'finished' },
  });
  orchestrator.registerExecutor('claude', executor);

  await orchestrator.dispatchOrResume(task.meta.id, { executor: 'claude' });

  const prompt = executor.starts[0]?.prompt ?? '';
  expect(prompt).toContain('## Comments');
  expect(prompt).toContain('the config loader ignores it');
});
