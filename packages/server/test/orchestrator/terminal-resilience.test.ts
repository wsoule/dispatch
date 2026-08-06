import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { EpicEngine } from '../../src/orchestrator/epic.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { runsDir, transcriptPath } from '../../src/orchestrator/paths.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-resilience-');
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
  epics: EpicEngine;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  terminal: RunMeta[];
}

// Every run parks at one approval gate, so a test can corrupt state while the
// run is live and then release it into its terminal path. `session` scripts the
// executor to report a resume handle mid-run, before that gate.
function makeHarness(fillRetryDelayMs?: number, session?: string): Harness {
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
      session,
      steps: [{ approval: { requestId: 'go', toolName: 'noop', input: {} } }],
      finish: { state: 'finished', costUsd: 0, turns: 1 },
    })
  );
  const epics = new EpicEngine({
    rootDir: repo,
    store,
    cache,
    events,
    orchestrator,
    fillRetryDelayMs,
  });
  const terminal: RunMeta[] = [];
  orchestrator.onRunTerminal((meta) => terminal.push(meta));
  return { orchestrator, epics, store, cache, events, terminal };
}

// Replaces a task's file with merge-conflict markers — the shape a bad
// hand-edit or a conflicted merge leaves behind, which TaskStore.get throws on.
function corruptTaskFile(taskId: string): void {
  const dir = join(repo, '.dispatch', 'tasks');
  const file = readdirSync(dir).find((f) => f.startsWith(`${taskId}-`));
  if (file === undefined) throw new Error(`no task file for ${taskId}`);
  writeFileSync(
    join(dir, file),
    '<<<<<<< HEAD\nnot a task file\n=======\nalso not\n>>>>>>> other\n'
  );
}

describe('terminal bookkeeping never swallows the terminal hooks', () => {
  it('fires terminal hooks when the finishing run task file is unparseable', async () => {
    const { orchestrator, store, terminal } = makeHarness();
    const task = store.create({ title: 'corrupted on finish' });
    const run = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(run.id)?.meta.state === 'awaiting-approval'
    );

    corruptTaskFile(task.meta.id);
    orchestrator.approve(run.id, 'go', { allow: true });

    await waitFor(() => terminal.length > 0);
    expect(terminal[0].id).toBe(run.id);
    expect(orchestrator.getRun(run.id)?.meta.state).toBe('finished');
  });

  it('keeps dispatching an epic when a finished child task file is unparseable', async () => {
    const { orchestrator, epics, store, cache } = makeHarness();
    const epic = store.create({ title: 'epic', kind: 'epic' });
    const a = store.create({
      title: 'child a',
      parent: epic.meta.id,
      writes: ['shared.ts'],
    });
    const b = store.create({
      title: 'child b',
      parent: epic.meta.id,
      writes: ['shared.ts'],
    });
    cache.rebuild(store);

    await epics.start(epic.meta.id, { concurrency: 1, executor: 'fake' });
    await waitFor(() => orchestrator.list().length === 1);
    const first = orchestrator.list()[0];
    const secondId = first.taskId === a.meta.id ? b.meta.id : a.meta.id;

    corruptTaskFile(first.taskId);
    orchestrator.approve(first.id, 'go', { allow: true });

    await waitFor(() => orchestrator.list().some((r) => r.taskId === secondId));
    expect(
      orchestrator.list().filter((r) => r.taskId === secondId)
    ).toHaveLength(1);
  });

  it('retries a hook-driven fill that failed to dispatch anything', async () => {
    const { orchestrator, epics, store, cache } = makeHarness(50);
    const epic = store.create({ title: 'epic', kind: 'epic' });
    const a = store.create({ title: 'child a', parent: epic.meta.id });
    const b = store.create({ title: 'child b', parent: epic.meta.id });
    cache.rebuild(store);

    await epics.start(epic.meta.id, { concurrency: 1, executor: 'fake' });
    await waitFor(() => orchestrator.list().length === 1);
    const first = orchestrator.list()[0];
    const secondId = first.taskId === a.meta.id ? b.meta.id : a.meta.id;

    // The next fill's `git worktree add` fails outright — a transient repo
    // failure, not a conflict — so that fill dispatches nothing at all.
    const gitDir = join(repo, '.git');
    Bun.spawnSync(['chmod', '-R', '000', gitDir]);
    try {
      orchestrator.approve(first.id, 'go', { allow: true });
      await waitFor(() =>
        (store.get(epic.meta.id)?.body ?? '').includes(
          '[hook error] auto-dispatch failed'
        )
      );
    } finally {
      Bun.spawnSync(['chmod', '-R', '755', gitDir]);
    }

    await waitFor(() => orchestrator.list().some((r) => r.taskId === secondId));
    epics.stop(epic.meta.id);
  });

  it('fires terminal hooks when a cancelled run task file is unparseable', async () => {
    const { orchestrator, store, terminal } = makeHarness();
    const task = store.create({ title: 'corrupted on cancel' });
    const run = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(run.id)?.meta.state === 'awaiting-approval'
    );

    corruptTaskFile(task.meta.id);
    await orchestrator.cancel(run.id);

    expect(terminal.map((m) => m.id)).toContain(run.id);
    expect(orchestrator.getRun(run.id)?.meta.state).toBe('cancelled');
  });

  it('completes a cancel whose transcript can no longer be appended to', async () => {
    const { orchestrator, store, terminal } = makeHarness();
    const task = store.create({ title: 'unwritable transcript' });
    const run = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(run.id)?.meta.state === 'awaiting-approval'
    );

    // A directory where the transcript file belongs: every append now throws
    // EISDIR, the same way a full or read-only disk would.
    const path = transcriptPath(repo, run.id);
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });

    await orchestrator.cancel(run.id);

    expect(terminal.map((m) => m.id)).toContain(run.id);
    expect(orchestrator.list().find((r) => r.id === run.id)?.state).toBe(
      'cancelled'
    );
  });

  it('still reports a dirty crashed run when its transcript cannot be written', async () => {
    const first = makeHarness();
    const task = first.store.create({ title: 'crashed mid-run' });
    const run = await first.orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () =>
        first.orchestrator.getRun(run.id)?.meta.state === 'awaiting-approval'
    );
    // Uncommitted work in the worktree: the whole reason a crashed run is
    // surveyed rather than just marked failed.
    writeFileSync(
      join(run.worktreePath, 'unsaved.ts'),
      'export const x = 1;\n'
    );

    // A fresh process over the same project: the run's transcript is still
    // non-terminal, so boot reconciliation force-fails it and surveys it.
    const next = makeHarness();
    const surveys: string[] = [];
    next.events.add({
      send: (data: string) => {
        const event = JSON.parse(data) as { type: string; runId?: string };
        if (event.type === 'run.survey' && event.runId !== undefined) {
          surveys.push(event.runId);
        }
      },
    });
    next.orchestrator.reconcileOnBoot();
    // The survey is deferred, so this lands while it is still in flight — the
    // run state directory is gone by the time it tries to record its result.
    rmSync(runsDir(repo), { recursive: true, force: true });

    await waitFor(() => surveys.includes(run.id));
    expect(next.orchestrator.list().find((r) => r.id === run.id)?.state).toBe(
      'interrupted-dirty'
    );
  });
});

describe('a run force-failed by boot reconciliation stays resumable', () => {
  it('keeps the session id the executor reported mid-run', async () => {
    const first = makeHarness(undefined, 'sess-mid-run');
    const task = first.store.create({ title: 'crashed before finishing' });
    const run = await first.orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () =>
        first.orchestrator.getRun(run.id)?.meta.state === 'awaiting-approval'
    );

    // A fresh process over the same project — a daemon restart. The run never
    // reached a terminal state, so boot reconciliation force-fails it.
    const next = makeHarness();
    next.orchestrator.reconcileOnBoot();

    const healed = next.orchestrator.list().find((r) => r.id === run.id);
    expect(healed?.state).toBe('failed');
    // The point of the whole exercise: a session id only ever written at
    // finish is lost on exactly the runs that most need resuming, because a
    // crashed run never reaches its finish. Orchestrator.sendMessage's
    // `resume: true` gate keys on this field, so without it the run is dead.
    expect(healed?.sessionId).toBe('sess-mid-run');
  });
});
