import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import type { JudgmentClient } from '../../src/judgments/client.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo } from './helpers.js';

// dispatchOrResume's model choice with a judgment client: a routine task
// judged small runs on the executor's plan tier; a model the caller names is
// never overridden; no client dispatches on the configured default as before.
// The scripted executor is registered as `claude` so the `models:` block
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
  for (const name of ['claude', 'codex', 'tiered', 'bare']) {
    orchestrator.registerExecutor(
      name,
      new FakeExecutor({ steps: [], finish: { state: 'finished' } })
    );
  }
  return { orchestrator, store };
}

describe('dispatchOrResume model tier', () => {
  it('lowers routine small work to the planning tier and logs why', async () => {
    const { orchestrator, store } = makeOrchestrator(stub('small', 0.9));
    const task = store.create({ title: 'Rename a flag', status: 'ready' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
      defaults: { model: 'coding-model' },
    });
    expect(meta.model).toBe('planning-model');
    expect(store.get(task.meta.id)?.body).toContain(
      `[run ${meta.id}] model planning-model: judged small (0.90) on routine risk`
    );
  });

  it('never overrides a model the caller named', async () => {
    const { orchestrator, store } = makeOrchestrator(stub('small', 0.9));
    const task = store.create({ title: 'Rename a flag', status: 'ready' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
      model: 'named-model',
    });
    expect(meta.model).toBe('named-model');
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

    const none = makeOrchestrator(null);
    const t2 = none.store.create({ title: 'Rename a flag', status: 'ready' });
    const m2 = await none.orchestrator.dispatchOrResume(t2.meta.id, {
      executor: 'claude',
    });
    expect(m2.model).toBe('coding-model');
  });

  it('judges only executors that configure both tiers; others keep their own default', async () => {
    const { orchestrator, store } = makeOrchestrator(stub('small', 0.9));
    const codexTask = store.create({ title: 'Rename a flag', status: 'ready' });
    const codex = await orchestrator.dispatchOrResume(codexTask.meta.id, {
      executor: 'codex',
    });
    expect(codex.model).toBe('codex-coding');
    expect(store.get(codexTask.meta.id)?.body).not.toContain('judged');

    const tieredTask = store.create({
      title: 'Rename a flag',
      status: 'ready',
    });
    const tiered = await orchestrator.dispatchOrResume(tieredTask.meta.id, {
      executor: 'tiered',
    });
    expect(tiered.model).toBe('tiered-planning');

    const bareTask = store.create({ title: 'Rename a flag', status: 'ready' });
    const bare = await orchestrator.dispatchOrResume(bareTask.meta.id, {
      executor: 'bare',
    });
    expect(bare.model).toBeUndefined();
  });
});
