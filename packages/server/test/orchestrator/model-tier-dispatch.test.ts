import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import type { JudgmentClient } from '../../src/judgments/client.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo, StallingExecutor } from './helpers.js';

// dispatchOrResume's model choice with a judgment client: a routine task
// judged small runs on the executor's plan tier; a model the caller names is
// never overridden; no client dispatches on the configured default as before.
// The recording executor is registered as `claude` so the `models:` block
// applies to it, and as `codex` for the per-executor block.

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

function stub(choice: string, confidence: number): JudgmentClient {
  return {
    model: 'jev-test',
    judge: () =>
      Promise.resolve({
        model: 'jev-test',
        answers: {
          complexity: { type: 'choice', choice, confidence, probabilities: {} },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never),
  };
}

function makeOrchestrator(judgments: JudgmentClient | null): {
  orchestrator: Orchestrator;
  store: TaskStore;
  executors: Map<string, StallingExecutor>;
} {
  const store = TaskStore.init(repo);
  writeFileSync(
    join(repo, '.dispatch', 'config.yml'),
    'models:\n  execute: coding-model\n  plan: planning-model\n' +
      'executors:\n  codex:\n    models:\n      execute: codex-coding\n' +
      '  tiered:\n    models:\n      execute: tiered-coding\n      plan: tiered-planning\n'
  );
  const cache = new TaskCache();
  cache.rebuild(store);
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
    judgments,
  });
  const executors = new Map<string, StallingExecutor>();
  for (const name of ['claude', 'codex', 'tiered', 'bare']) {
    const executor = new StallingExecutor();
    executors.set(name, executor);
    orchestrator.registerExecutor(name, executor);
  }
  return { orchestrator, store, executors };
}

describe('dispatchOrResume model tier', () => {
  it('lowers routine small work to the planning tier and logs why', async () => {
    const { orchestrator, store, executors } = makeOrchestrator(
      stub('small', 0.9)
    );
    const task = store.create({ title: 'Rename a flag', status: 'ready' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
      defaults: { model: 'coding-model' },
    });
    expect(meta.model).toBe('planning-model');
    expect(executors.get('claude')?.started.map((s) => s.model)).toEqual([
      'planning-model',
    ]);
    expect(store.get(task.meta.id)?.body).toContain(
      `[run ${meta.id}] model planning-model: judged small (0.90) on routine risk`
    );
  });

  it('never overrides a model the caller named', async () => {
    const judgments = stub('small', 0.9);
    const judge = spyOn(judgments, 'judge');
    const { orchestrator, store, executors } = makeOrchestrator(judgments);
    const task = store.create({
      title: 'Rename a flag',
      status: 'ready',
      model: 'task-model',
    });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
      model: 'named-model',
    });
    expect(meta.model).toBe('named-model');
    expect(executors.get('claude')?.started.map((s) => s.model)).toEqual([
      'named-model',
    ]);
    expect(judge).not.toHaveBeenCalled();
    expect(store.get(task.meta.id)?.body).not.toContain('judged');
  });

  it('keeps the default for substantial work and without a client', async () => {
    const substantial = makeOrchestrator(stub('substantial', 0.9));
    const t1 = substantial.store.create({
      title: 'Rewrite it',
      status: 'ready',
    });
    const m1 = await substantial.orchestrator.dispatchOrResume(t1.meta.id, {
      executor: 'claude',
      defaults: { model: 'coding-model' },
    });
    expect(m1.model).toBe('coding-model');
    expect(
      substantial.executors.get('claude')?.started.map((s) => s.model)
    ).toEqual(['coding-model']);

    const none = makeOrchestrator(null);
    const t2 = none.store.create({ title: 'Rename a flag', status: 'ready' });
    const m2 = await none.orchestrator.dispatchOrResume(t2.meta.id, {
      executor: 'claude',
    });
    expect(m2.model).toBe('coding-model');
    expect(none.executors.get('claude')?.started.map((s) => s.model)).toEqual([
      'coding-model',
    ]);
  });

  it('judges only executors that configure both tiers; others keep their own default', async () => {
    const { orchestrator, store, executors } = makeOrchestrator(
      stub('small', 0.9)
    );
    const codexTask = store.create({ title: 'Rename a flag', status: 'ready' });
    const codex = await orchestrator.dispatchOrResume(codexTask.meta.id, {
      executor: 'codex',
    });
    expect(codex.model).toBe('codex-coding');
    expect(executors.get('codex')?.started.map((s) => s.model)).toEqual([
      'codex-coding',
    ]);
    expect(store.get(codexTask.meta.id)?.body).not.toContain('judged');

    const tieredTask = store.create({
      title: 'Rename a flag',
      status: 'ready',
    });
    const tiered = await orchestrator.dispatchOrResume(tieredTask.meta.id, {
      executor: 'tiered',
    });
    expect(tiered.model).toBe('tiered-planning');
    expect(executors.get('tiered')?.started.map((s) => s.model)).toEqual([
      'tiered-planning',
    ]);

    const bareTask = store.create({ title: 'Rename a flag', status: 'ready' });
    const bare = await orchestrator.dispatchOrResume(bareTask.meta.id, {
      executor: 'bare',
    });
    expect(bare.model).toBeUndefined();
    expect(executors.get('bare')?.started.map((s) => s.model)).toEqual([
      undefined,
    ]);
  });

  it.each([false, true])(
    'honors the task model with judgment enabled: %s',
    async (enabled) => {
      const judgments = stub('small', 0.9);
      const judge = spyOn(judgments, 'judge');
      const { orchestrator, store, executors } = makeOrchestrator(
        enabled ? judgments : null
      );
      const task = store.create({
        title: 'Rename a flag',
        status: 'ready',
        model: 'task-model',
      });
      const meta = await orchestrator.dispatchOrResume(task.meta.id, {
        executor: 'claude',
        defaults: { model: 'caller-default' },
      });
      expect(meta.model).toBe('task-model');
      expect(executors.get('claude')?.started.map((s) => s.model)).toEqual([
        'task-model',
      ]);
      expect(judge).not.toHaveBeenCalled();
      expect(store.get(task.meta.id)?.body).not.toContain('judged');
    }
  );

  it('uses the caller default before executor config without judgment', async () => {
    const { orchestrator, store, executors } = makeOrchestrator(null);
    const task = store.create({ title: 'Rename a flag', status: 'ready' });
    await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
      defaults: { model: 'caller-default' },
    });
    expect(executors.get('claude')?.started.map((s) => s.model)).toEqual([
      'caller-default',
    ]);
  });
});
