import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import { FindingStore } from '../src/findings.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import { OrchestratorConflictError } from '../src/orchestrator/types.js';
import { initGitRepo } from './orchestrator/helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-blocked-gate-');
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

interface Harness {
  orchestrator: Orchestrator;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  findings: FindingStore;
}

function makeHarness(): Harness {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      steps: [
        {
          write: (cwd) =>
            writeFileSync(join(cwd, 'src.ts'), 'export const a = 1;\n'),
          commitMessage: 'agent work',
        },
      ],
      finish: { state: 'finished', costUsd: 0, turns: 1, sessionId: 'sess' },
    })
  );
  return {
    orchestrator,
    store,
    cache,
    events,
    findings: new FindingStore(repo),
  };
}

// A run that has finished its work and is sitting exactly where a merge
// decision is made: terminal, unreviewed, no PR.
async function finishedRun(
  harness: Harness
): Promise<{ runId: string; taskId: string }> {
  const task = harness.store.create({ title: 'shippable work' });
  const meta = await harness.orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(
    () => harness.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  return { runId: meta.id, taskId: task.meta.id };
}

// The state a human's blocking ruling leaves behind: a critical finding whose
// verdict is `blocked`, carrying the written ruling adjudication demands.
function blockTask(harness: Harness, taskId: string, runId: string): void {
  const finding = harness.findings.add({
    taskId,
    runId,
    severity: 'critical',
    title: 'leaks the session token',
    detail: 'logs the raw token on every request',
  });
  harness.findings.update(finding.id, {
    verdict: 'blocked',
    ruling: 'not shipping this until the token handling is redone',
  });
}

// Every queue command succeeds except `jj`, which is absent — the plain-git
// path, so the queue reaches merge() through the orchestrator's own review.
const noJjRunner = (_cwd: string, cmd: string[]): Promise<CommandResult> =>
  Promise.resolve(
    cmd[0] === 'jj'
      ? { ok: false, stdout: '', stderr: 'jj: command not found' }
      : { ok: true, stdout: '', stderr: '' }
  );

// The same runner, plus a record of what the queue actually ran — a PR entry
// merges through `gh`, so only the call log proves it was never merged.
function recordingRunner(): {
  calls: string[][];
  run: (cwd: string, cmd: string[]) => Promise<CommandResult>;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cwd, cmd) => {
      calls.push(cmd);
      return noJjRunner(cwd, cmd);
    },
  };
}

describe('a blocked finding gates every merge path', () => {
  it('refuses a local squash-merge of a blocked task', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await finishedRun(harness);
    blockTask(harness, taskId, runId);

    expect(() => harness.orchestrator.review(runId, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(harness.orchestrator.getRun(runId)?.meta.reviewedAt).toBeUndefined();
  });

  it('still allows discarding a blocked task', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await finishedRun(harness);
    blockTask(harness, taskId, runId);

    const reviewed = harness.orchestrator.review(runId, 'discard');
    expect(reviewed.reviewAction).toBe('discard');
  });

  it('refuses to enqueue a blocked task in the merge queue', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await finishedRun(harness);
    blockTask(harness, taskId, runId);
    const queue = new MergeQueue(
      {
        rootDir: repo,
        store: harness.store,
        cache: harness.cache,
        events: harness.events,
        orchestrator: harness.orchestrator,
      },
      noJjRunner
    );

    try {
      expect(() => queue.enqueue(runId)).toThrow(OrchestratorConflictError);
      expect(queue.snapshot().entries).toHaveLength(0);
    } finally {
      queue.stop();
    }
  });

  it('leaves a blocked task out of "merge all ready"', async () => {
    const harness = makeHarness();
    const blocked = await finishedRun(harness);
    blockTask(harness, blocked.taskId, blocked.runId);
    const shippable = await finishedRun(harness);
    const queue = new MergeQueue(
      {
        rootDir: repo,
        store: harness.store,
        cache: harness.cache,
        events: harness.events,
        orchestrator: harness.orchestrator,
      },
      noJjRunner
    );

    try {
      const enqueued = queue.enqueueReady();
      expect(enqueued.map((e) => e.runId)).toEqual([shippable.runId]);
    } finally {
      queue.stop();
    }
  });

  it('fails an already-queued entry whose task is blocked before it merges', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await finishedRun(harness);
    const queue = new MergeQueue(
      {
        rootDir: repo,
        store: harness.store,
        cache: harness.cache,
        events: harness.events,
        orchestrator: harness.orchestrator,
      },
      noJjRunner
    );

    try {
      // Blocked after admission, exactly as a human adjudicating a finding
      // while the entry waits its turn would.
      queue.enqueue(runId);
      blockTask(harness, taskId, runId);
      await waitFor(() => queue.snapshot().history.length === 1);

      const done = queue.snapshot().history[0];
      expect(done.state).toBe('failed');
      expect(done.reason).toContain('blocked');
      expect(
        harness.orchestrator.getRun(runId)?.meta.reviewedAt
      ).toBeUndefined();
    } finally {
      queue.stop();
    }
  });

  it('never runs gh pr merge for an entry blocked after admission', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await finishedRun(harness);
    harness.orchestrator.setRunPrUrl(runId, 'https://example.test/pr/1');
    const runner = recordingRunner();
    const queue = new MergeQueue(
      {
        rootDir: repo,
        store: harness.store,
        cache: harness.cache,
        events: harness.events,
        orchestrator: harness.orchestrator,
      },
      runner.run
    );

    try {
      queue.enqueue(runId);
      blockTask(harness, taskId, runId);
      await waitFor(() => queue.snapshot().history.length === 1);

      expect(queue.snapshot().history[0].state).toBe('failed');
      expect(queue.snapshot().history[0].reason).toContain('blocked');
      expect(runner.calls.some((cmd) => cmd[0] === 'gh')).toBe(false);
    } finally {
      queue.stop();
    }
  });
});
