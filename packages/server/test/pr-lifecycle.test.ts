import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus, type ServerEvent } from '../src/events.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { prLifecyclePath, runsDir } from '../src/orchestrator/paths.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import { PR_LIFECYCLE_FIELDS, PrManager } from '../src/orchestrator/pr.js';
import {
  PrLifecycle,
  type PrLifecycleRun,
  type PrLifecycleState,
  PrLifecycleStore,
  type PrView,
} from '../src/orchestrator/prLifecycle.js';
import { ReviewCommentStore } from '../src/reviewComments.js';
import { initGitRepo } from './orchestrator/helpers.js';

// Task 2 of the landing-via-PRs plan: the per-PR lifecycle record, the
// mapping from a `gh pr view` payload to a PrPhase, and the poller that feeds
// it. Covers the two review-focus cases this task owns: a `gh` failure keeps
// the state it had, and a daemon restart reads the state back from disk.
let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-pr-lifecycle-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const PR_URL = 'https://github.com/example/repo/pull/7';

const RUN: PrLifecycleRun = {
  id: 'r-1',
  taskId: 't-1',
  prUrl: PR_URL,
  branch: 'dispatch/t-1',
  baseBranch: 'main',
};

// A `gh pr view --json PR_LIFECYCLE_FIELDS` payload, open and quiet unless
// a test overrides a field.
function view(overrides: Partial<PrView> = {}): PrView {
  return {
    state: 'OPEN',
    headRefOid: 'sha-1',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    statusCheckRollup: [
      { name: 'Build, test, lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    autoMergeRequest: null,
    ...overrides,
  };
}

function prChanged(events: ServerEvent[]): ServerEvent[] {
  return events.filter((e) => e.type === 'pr.changed');
}

function lifecycle(): {
  life: PrLifecycle;
  store: PrLifecycleStore;
  events: ServerEvent[];
} {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store = new PrLifecycleStore(repo);
  const life = new PrLifecycle(store, bus, (runId) =>
    runId === RUN.id ? RUN : null
  );
  return { life, store, events };
}

describe('PrLifecycle.observe', () => {
  test('observe maps CHANGES_REQUESTED to changes-requested', () => {
    const { life, store, events } = lifecycle();
    life.observe(RUN.id, view({ reviewDecision: 'CHANGES_REQUESTED' }));
    const state = store.get('r-1');
    expect(state?.phase).toBe('changes-requested');
    expect(state?.number).toBe(7);
    expect(state?.headSha).toBe('sha-1');
    expect(prChanged(events)).toEqual([
      {
        type: 'pr.changed',
        runId: 'r-1',
        taskId: 't-1',
        phase: 'changes-requested',
        reason: 'changes requested',
      },
    ]);
  });

  test('failing required check maps to checks-failed', () => {
    const { life, store } = lifecycle();
    life.observe(
      RUN.id,
      view({
        statusCheckRollup: [
          {
            name: 'Build, test, lint',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
          },
          { name: 'docs', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      })
    );
    const state = store.get('r-1');
    expect(state?.phase).toBe('checks-failed');
    expect(state?.reason).toBe('failing: Build, test, lint');
  });

  test('pending checks map to checks-running, then ready once they pass', () => {
    const { life, store, events } = lifecycle();
    life.observe(
      RUN.id,
      view({
        statusCheckRollup: [{ name: 'Build, test, lint', status: 'QUEUED' }],
        autoMergeRequest: { enabledAt: '2026-10-26T00:00:00Z' },
      })
    );
    expect(store.get('r-1')?.phase).toBe('checks-running');
    expect(store.get('r-1')?.autoMergeArmed).toBe(true);
    life.observe(RUN.id, view());
    expect(store.get('r-1')?.phase).toBe('ready');
    expect(store.get('r-1')?.autoMergeArmed).toBe(false);
    expect(prChanged(events)).toHaveLength(2);
  });

  test('an unchanged view emits nothing and writes nothing', () => {
    const { life, store, events } = lifecycle();
    life.observe(RUN.id, view());
    const first = store.get('r-1');
    life.observe(RUN.id, view());
    expect(prChanged(events)).toHaveLength(1);
    expect(store.get('r-1')?.updatedAt).toBe(first?.updatedAt);
  });

  test('an action phase is kept until GitHub reports the PR finished', () => {
    const { life, store } = lifecycle();
    life.observe(RUN.id, view());
    const resolving: PrLifecycleState = {
      ...store.get('r-1')!,
      phase: 'resolving',
      reason: 'conflict',
    };
    store.save(resolving);
    life.observe(RUN.id, view({ reviewDecision: 'CHANGES_REQUESTED' }));
    expect(store.get('r-1')?.phase).toBe('resolving');
    expect(store.get('r-1')?.reason).toBe('conflict');
    life.observe(RUN.id, view({ state: 'CLOSED' }));
    expect(store.get('r-1')?.phase).toBe('closed');
  });

  test('a gh failure followed by recovery gives back the reason it replaced', () => {
    const { life, store, events } = lifecycle();
    life.observe(RUN.id, view());
    store.save({
      ...store.get('r-1')!,
      phase: 'needs-you',
      reason: 'rereview cap reached',
    });
    life.reportFailure(RUN.id, 'gh: not logged in');
    expect(store.get('r-1')?.phase).toBe('needs-you');
    expect(store.get('r-1')?.reason).toBe('gh: not logged in');
    // The same failure again is not a new change.
    life.reportFailure(RUN.id, 'gh: not logged in');
    expect(prChanged(events)).toHaveLength(2);
    life.observe(RUN.id, view());
    expect(store.get('r-1')?.phase).toBe('needs-you');
    expect(store.get('r-1')?.reason).toBe('rereview cap reached');
    expect(store.get('r-1')?.ghError).toBeNull();
  });
});

describe('PrLifecycle unknown runs', () => {
  test('observing a run with no record and no run is refused', () => {
    const { life, store, events } = lifecycle();
    expect(() => life.observe('r-missing', view())).toThrow(
      'run not found: r-missing'
    );
    expect(store.list()).toEqual([]);
    expect(prChanged(events)).toEqual([]);
  });
});

describe('PrLifecycleStore', () => {
  test('lifecycle state survives restart', () => {
    const { life, store } = lifecycle();
    life.observe(RUN.id, view());
    store.save({
      ...store.get('r-1')!,
      phase: 'resolving',
      resolveAttempts: 1,
    });

    const restarted = new PrLifecycleStore(repo);
    const state = restarted.get('r-1');
    expect(state?.phase).toBe('resolving');
    expect(state?.resolveAttempts).toBe(1);
    expect(restarted.list().map((s) => s.runId)).toEqual(['r-1']);
  });

  test('a corrupt file is moved aside rather than overwritten', () => {
    mkdirSync(runsDir(repo), { recursive: true });
    writeFileSync(prLifecyclePath(repo), '{not json');
    const { life, store } = lifecycle();
    expect(store.list()).toEqual([]);
    life.observe(RUN.id, view());
    const kept = readdirSync(runsDir(repo)).filter((f) =>
      f.startsWith('pr-lifecycle.json.corrupt-')
    );
    expect(kept).toHaveLength(1);
    expect(new PrLifecycleStore(repo).get('r-1')?.phase).toBe('ready');
  });
});

// Answers `gh pr list` with an empty list and `gh pr view --json
// PR_LIFECYCLE_FIELDS` with a scriptable result, recording every argv.
class FakeRunner {
  readonly calls: string[][] = [];
  viewResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify(view()),
    stderr: '',
  };

  run = (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push(cmd);
    if (cmd[0] === 'git' && cmd[1] === 'push') {
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    }
    if (cmd[0] === 'gh' && cmd[2] === 'create') {
      return Promise.resolve({ ok: true, stdout: `${PR_URL}\n`, stderr: '' });
    }
    if (cmd[0] === 'gh' && cmd[2] === 'list') {
      return Promise.resolve({ ok: true, stdout: '[]', stderr: '' });
    }
    if (
      cmd[0] === 'gh' &&
      cmd[2] === 'view' &&
      cmd[cmd.indexOf('--json') + 1] === PR_LIFECYCLE_FIELDS
    ) {
      return Promise.resolve(this.viewResult);
    }
    return Promise.resolve({ ok: false, stdout: '', stderr: 'unhandled' });
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

// A real orchestrator with one finished fake run that has an open PR, the
// PrManager polling it, and every event it broadcasts.
async function polledRun(): Promise<{
  pr: PrManager;
  runner: FakeRunner;
  orchestrator: Orchestrator;
  store: TaskStore;
  runId: string;
  taskId: string;
  events: ServerEvent[];
}> {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const bus = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: bus,
  });
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({ finish: { state: 'finished', costUsd: 0, turns: 1 } })
  );
  const task = store.create({ title: 'PR me' });
  const meta = await orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'finished');
  const runner = new FakeRunner();
  const pr = new PrManager(
    {
      rootDir: repo,
      store,
      cache,
      events: bus,
      orchestrator,
      reviewComments: new ReviewCommentStore(repo, 'human:test'),
    },
    true,
    runner.run
  );
  await pr.openPr(meta.id);
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return {
    pr,
    runner,
    orchestrator,
    store,
    runId: meta.id,
    taskId: task.meta.id,
    events,
  };
}

describe('PrManager.pollOnce lifecycle', () => {
  test('MERGED maps to merged and marks the run reviewed', async () => {
    const { pr, runner, orchestrator, runId, events } = await polledRun();
    runner.viewResult = {
      ok: true,
      stdout: JSON.stringify(view({ state: 'MERGED' })),
      stderr: '',
    };
    await pr.pollOnce();
    expect(pr.lifecycle.store.get(runId)?.phase).toBe('merged');
    expect(orchestrator.getRun(runId)?.meta.reviewedAt).toBeDefined();
    expect(prChanged(events)).toHaveLength(1);
  });

  test('pollOnce keeps state and reports gh failure', async () => {
    const { pr, runner, orchestrator, store, runId, taskId, events } =
      await polledRun();
    runner.viewResult = {
      ok: true,
      stdout: JSON.stringify(view({ reviewDecision: 'CHANGES_REQUESTED' })),
      stderr: '',
    };
    await pr.pollOnce();
    expect(pr.lifecycle.store.get(runId)?.phase).toBe('changes-requested');

    runner.viewResult = {
      ok: false,
      stdout: '',
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    };
    await pr.pollOnce();
    const state = pr.lifecycle.store.get(runId);
    expect(state?.phase).toBe('changes-requested');
    expect(state?.headSha).toBe('sha-1');
    expect(state?.reason).toContain('gh pr view failed');
    expect(state?.reason).toContain('gh auth login');
    expect(prChanged(events).at(-1)).toEqual({
      type: 'pr.changed',
      runId,
      taskId,
      phase: 'changes-requested',
      reason: state!.reason,
    });
    expect(existsSync(prLifecyclePath(repo))).toBe(true);
    // gh being logged out neither loses the run nor lands it locally: it
    // keeps its PR, stays un-reviewed, and is polled again next pass.
    const run = orchestrator.getRun(runId)?.meta;
    expect(run?.prUrl).toBe(PR_URL);
    expect(run?.reviewedAt).toBeUndefined();
    expect(store.get(taskId)?.meta.status).not.toBe('done');
    const viewsBefore = runner.calls.filter((c) => c[2] === 'view').length;
    await pr.pollOnce();
    expect(runner.calls.filter((c) => c[2] === 'view').length).toBe(
      viewsBefore + 1
    );
  });

  test('unparseable gh output is reported the same way', async () => {
    const { pr, runner, runId } = await polledRun();
    runner.viewResult = { ok: true, stdout: 'not json', stderr: '' };
    await pr.pollOnce();
    const state = pr.lifecycle.store.get(runId);
    expect(state?.phase).toBe('checks-running');
    expect(state?.reason).toBe('gh pr view returned invalid JSON');
  });
});
