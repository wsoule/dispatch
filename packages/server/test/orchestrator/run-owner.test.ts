import { ActorContext, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { initGitRepo, StallingExecutor } from './helpers.js';

// Whom a run is for (RunMeta.dispatchedBy): the Cockpit's "me" lane, presence
// and the decision feed all read it on a daemon more than one person uses.

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-run-owner-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

// The daemon's local human resolves to `human:test` from this git identity.
const gitReader = (args: string[]): string =>
  args.includes('user.email') ? 'test@example.com' : 'Test';

function harness() {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
    actorContext: ActorContext.resolve(repo, gitReader),
  });
  orchestrator.registerExecutor('fake', new StallingExecutor());
  return { orchestrator, store };
}

// A run that commits work and then fails with a session to resume; later
// runs on 'fake' stall, so a successor stays live to be inspected.
async function failedRun(
  h: ReturnType<typeof harness>,
  opts: { actor?: string; dispatchedBy?: string }
): Promise<RunMeta> {
  h.orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      session: 'session-1',
      steps: [
        {
          write: (cwd) => writeFileSync(join(cwd, 'work.txt'), 'wip\n'),
          commitMessage: 'agent: wip',
        },
      ],
      finish: { state: 'failed', error: 'dropped', sessionId: 'session-1' },
    })
  );
  const task = h.store.create({ title: 'Owned work' });
  const meta = await h.orchestrator.dispatch(task.meta.id, 'fake', opts);
  await waitFor(() => h.orchestrator.getRun(meta.id)?.meta.state === 'failed');
  h.orchestrator.registerExecutor('fake', new StallingExecutor());
  return meta;
}

describe('dispatch', () => {
  it('is the pressing human’s by default, and nobody’s for a bare automatic caller', async () => {
    const h = harness();
    const manual = await h.orchestrator.dispatch(
      h.store.create({ title: 'Manual' }).meta.id,
      'fake'
    );
    expect(manual.dispatchedBy).toBe('human:test');
    const teammate = await h.orchestrator.dispatch(
      h.store.create({ title: 'Teammate' }).meta.id,
      'fake',
      { actor: 'human:ada' }
    );
    expect(teammate.dispatchedBy).toBe('human:ada');
    const nobody = await h.orchestrator.dispatch(
      h.store.create({ title: 'Nobody' }).meta.id,
      'fake',
      { actor: 'none' }
    );
    expect(nobody.dispatchedBy).toBeUndefined();
  });

  it('is for `dispatchedBy` when an automatic caller names whom it works for', async () => {
    const h = harness();
    const taskId = h.store.create({ title: 'Fan-out child' }).meta.id;
    const meta = await h.orchestrator.dispatchOrResume(taskId, {
      executor: 'fake',
      actor: 'none',
      dispatchedBy: 'human:ada',
    });
    expect(meta.dispatchedBy).toBe('human:ada');
    // Only a person owns a run.
    const bare = await h.orchestrator.dispatchOrResume(
      h.store.create({ title: 'Bare' }).meta.id,
      { executor: 'fake', actor: 'none', dispatchedBy: 'human' }
    );
    expect(bare.dispatchedBy).toBeUndefined();
  });
});

describe('a run that continues another', () => {
  it('a fan-out’s resume is its starter’s, whoever the failed run was for', async () => {
    const h = harness();
    const failed = await failedRun(h, {});
    expect(failed.dispatchedBy).toBe('human:test');
    const resumed = await h.orchestrator.dispatchOrResume(failed.taskId, {
      actor: 'none',
      dispatchedBy: 'human:ada',
    });
    expect(resumed.resumedFrom).toBe(failed.id);
    expect(resumed.dispatchedBy).toBe('human:ada');
  });

  it('a person’s resume is theirs; the boot sweep’s keeps the predecessor’s', async () => {
    const h = harness();
    const failed = await failedRun(h, { actor: 'human:ada' });
    const auto = h.orchestrator.resumeRun(failed.id, { auto: true });
    expect(auto.dispatchedBy).toBe('human:ada');

    const other = await failedRun(h, { actor: 'human:ada' });
    const pressed = h.orchestrator.resumeRun(other.id, { actor: 'human:sam' });
    expect(pressed.dispatchedBy).toBe('human:sam');
  });

  it('a fix-loop follow-up stays its conversation’s; a person’s request is theirs', async () => {
    const h = harness();
    const failed = await failedRun(h, { actor: 'human:ada' });
    const round = h.orchestrator.sendMessage(failed.id, 'fix the findings', {
      resume: true,
      actor: 'none',
    });
    expect(round.dispatchedBy).toBe('human:ada');

    const other = await failedRun(h, { actor: 'human:ada' });
    const asked = h.orchestrator.sendMessage(other.id, 'try again', {
      resume: true,
      actor: 'human:sam',
    });
    expect(asked.dispatchedBy).toBe('human:sam');
  });

  it('a review or verify run is for whoever its task’s work is for', async () => {
    const h = harness();
    const failed = await failedRun(h, {
      actor: 'none',
      dispatchedBy: 'human:ada',
    });
    const review = await h.orchestrator.dispatchAuxRun({
      taskId: failed.taskId,
      kind: 'review',
      executor: 'fake',
      head: failed.branch,
      buildPrompt: () => 'review it',
      operator: null,
    });
    expect(review.dispatchedBy).toBe('human:ada');

    // No execute run: nobody's.
    const orphan = await h.orchestrator.dispatchAuxRun({
      taskId: h.store.create({ title: 'Loose' }).meta.id,
      kind: 'verify',
      executor: 'fake',
      head: 'main',
      buildPrompt: () => 'verify it',
      operator: null,
    });
    expect(orphan.dispatchedBy).toBeUndefined();
  });
});
