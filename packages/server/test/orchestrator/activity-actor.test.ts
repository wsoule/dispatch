import { ActorContext, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo } from './helpers.js';

// Covers the finding from the whole-branch review: appendActivity/
// activityActor exist but nothing wired an actor through for the
// orchestrator's own Activity writers. These three tests are the minimum
// the review asked for — (a) an agent-driven line, (b) a human-driven line,
// (c) a system line — read together with mcp/test/task-comment-actor.test.ts
// for (d).

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

// Fixed git identity so ActorContext resolves deterministically (handle
// 'test', from the local part of the email) across every test here.
const testGitReader = (args: string[]): string =>
  args.includes('user.email') ? 'test@example.com' : 'Test';

function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makeOrchestrator(rootDir: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const actorContext = ActorContext.resolve(rootDir, testGitReader);
  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    events,
    actorContext,
  });
  return { orchestrator, store };
}

describe('Activity attribution', () => {
  it('(a) an agent-driven line — a run finishing — carries the agent ref', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ steps: [], finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Finish me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // handleFinish credits the run's own executor, formatted as
    // agent:<human handle>/<executor name> — never the human operating the
    // daemon.
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] finished: finished — 0 files, $0.00 — agent:test/fake`
    );
  });

  it('(b) a human-driven line — cancelling a run — carries the human ref', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', {
      start: (_opts, _events) => ({
        interrupt: async () => {},
        requestStop: () => {},
        send: () => {},
        approve: () => {},
      }),
    });
    const task = store.create({ title: 'Cancel me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    // cancel() has exactly one caller in production — the API's Cancel
    // button, a human action — so this is hardcoded to actorContext.humanRef
    // with no override.
    await orchestrator.cancel(meta.id);

    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] cancelled — human:test`
    );
  });

  it("(c) a mechanical line — a run lifecycle hook throwing — carries 'none'", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ steps: [], finish: { state: 'finished' } })
    );
    // A throwing subscriber is the daemon's own bookkeeping failing, not a
    // human or agent decision — invokeHooksSafely records it with 'none'.
    orchestrator.onRunTerminal(() => {
      throw new Error('boom');
    });
    const task = store.create({ title: 'Hook error' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    await waitFor(() => store.get(task.meta.id)!.body.includes('[hook error]'));

    expect(store.get(task.meta.id)!.body).toContain('[hook error] boom — none');
  });

  it("(c again) epic auto-fill dispatches with an explicit 'none' actor override", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ steps: [], finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Auto-filled' });

    // Mirrors EpicEngine.enqueueFill's own call exactly — the epic scheduler
    // decided this, no human pressed dispatch for this specific task.
    const meta = await orchestrator.dispatch(task.meta.id, 'fake', {
      actor: 'none',
    });

    expect(store.get(task.meta.id)!.body).toContain(
      `dispatched (fake, branch ${meta.branch}) — none`
    );
  });
});
