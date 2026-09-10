import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

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

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

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

// Dispatches a run whose fake agent writes `fileName` and commits, then waits
// for it to finish — the starting point of every external-merge scenario.
async function finishedRun(
  orchestrator: Orchestrator,
  store: TaskStore,
  fileName: string
): Promise<RunMeta> {
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      steps: [
        {
          write: (cwd) => {
            writeFileSync(join(cwd, fileName), 'done\n');
          },
          commitMessage: `agent: add ${fileName}`,
        },
      ],
      finish: { state: 'finished' },
    })
  );
  const task = store.create({ title: `Add ${fileName}` });
  const meta = await orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'finished');
  return orchestrator.getRun(meta.id)!.meta;
}

describe('Orchestrator.reconcileExternallyMergedRuns', () => {
  it('closes out a run whose branch was hand-merged with a merge commit', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await finishedRun(orchestrator, store, 'feature.txt');

    runGitSync(repo, ['merge', '--no-ff', meta.branch, '-m', 'hand merge']);
    const mergeSha = runGitSync(repo, ['rev-parse', 'HEAD']).trim();

    const reconciled = orchestrator.reconcileExternallyMergedRuns();

    expect(reconciled.map((r) => r.id)).toEqual([meta.id]);
    const after = orchestrator.getRun(meta.id)!.meta;
    expect(after.reviewedAt).toBeDefined();
    expect(after.reviewAction).toBe('merge');
    expect(after.mergeCommit).toBe(mergeSha);
    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(store.get(after.taskId)!.meta.status).toBe('landed');
    expect(store.get(after.taskId)!.body).toContain('merged outside dispatch');
  });

  it('closes out a run whose branch was hand-squash-merged', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await finishedRun(orchestrator, store, 'feature.txt');

    runGitSync(repo, ['merge', '--squash', meta.branch]);
    runGitSync(repo, ['commit', '-m', 'hand squash merge']);

    const reconciled = orchestrator.reconcileExternallyMergedRuns();

    expect(reconciled.map((r) => r.id)).toEqual([meta.id]);
    const after = orchestrator.getRun(meta.id)!.meta;
    expect(after.reviewedAt).toBeDefined();
    expect(after.reviewAction).toBe('merge');
    // A squash rewrites history, so no single merge commit is attributable.
    expect(after.mergeCommit).toBeUndefined();
    expect(store.get(after.taskId)!.meta.status).toBe('landed');
  });

  it('leaves an unmerged run alone', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await finishedRun(orchestrator, store, 'feature.txt');

    const reconciled = orchestrator.reconcileExternallyMergedRuns();

    expect(reconciled).toEqual([]);
    const after = orchestrator.getRun(meta.id)!.meta;
    expect(after.reviewedAt).toBeUndefined();
    expect(existsSync(meta.worktreePath)).toBe(true);
    expect(store.get(after.taskId)!.meta.status).toBe('review');
  });

  it('never mistakes a no-commit run for merged, even after base merges other work', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    // This agent finishes without committing anything: its branch tip stays
    // the base commit it was cut from — an ancestor of main forever after.
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'No-op run' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Main then merges UNRELATED work with a merge commit. That merge's
    // first parent is the very commit the no-op branch points at — the exact
    // shape a first-parent-blind detector would misread as "merged".
    runGitSync(repo, ['checkout', '-b', 'other-work']);
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'other work']);
    runGitSync(repo, ['checkout', 'main']);
    runGitSync(repo, ['merge', '--no-ff', 'other-work', '-m', 'merge other']);

    const reconciled = orchestrator.reconcileExternallyMergedRuns();

    expect(reconciled).toEqual([]);
    const after = orchestrator.getRun(meta.id)!.meta;
    expect(after.reviewedAt).toBeUndefined();
    expect(store.get(after.taskId)!.meta.status).not.toBe('landed');
  });
});
