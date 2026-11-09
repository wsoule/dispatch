import { DEFAULT_STATUS_MODEL } from '@dispatch-foo/core/browser';
import type { MergeQueueEntry, MergeQueueSnapshot } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  buildLandingBoard,
  canPullFromQueue,
  describeFailure,
  formatFiles,
  formatStageElapsed,
  landingMark,
  landingSections,
  landingStage,
  type LandingTask,
  stageDetail,
} from './landingQueue';

const NOW = new Date(2026, 10, 8, 15, 0, 0).getTime();
const at = (minutesAgo: number) =>
  new Date(NOW - minutesAgo * 60_000).toISOString();

function entry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    state: 'queued',
    enqueuedAt: at(30),
    stateSince: at(10),
    ...over,
  };
}

function task(id: string, over: Partial<LandingTask['meta']> = {}) {
  return {
    meta: { id, title: `Task ${id}`, status: 'todo', blockedBy: [], ...over },
  };
}

function board(
  snapshot: Partial<MergeQueueSnapshot>,
  tasks: LandingTask[] = []
) {
  return buildLandingBoard(
    { entries: [], history: [], ...snapshot },
    tasks,
    DEFAULT_STATUS_MODEL,
    NOW
  );
}

describe('landingStage', () => {
  test('folds every hold into queued and terminal states into landed/failed', () => {
    expect(landingStage('queued')).toBe('queued');
    expect(landingStage('waiting-blockers')).toBe('queued');
    expect(landingStage('blocked-environment')).toBe('queued');
    expect(landingStage('waiting-github')).toBe('queued');
    expect(landingStage('rebasing')).toBe('rebasing');
    expect(landingStage('verifying')).toBe('verifying');
    expect(landingStage('merging')).toBe('merging');
    expect(landingStage('merged')).toBe('landed');
    expect(landingStage('failed')).toBe('failed');
  });
});

describe('describeFailure', () => {
  const failed = (reason: string, over: Partial<MergeQueueEntry> = {}) =>
    describeFailure(entry({ state: 'failed', reason, ...over }));

  test('a rebase conflict names its files from the entry', () => {
    const f = failed('git rebase failed: error: could not apply 71fc328...', {
      conflicts: ['apps/a.ts', 'packages/b.ts', 'c.ts'],
    });
    expect(f.kind).toBe('rebase-conflict');
    expect(f.stage).toBe('rebasing');
    expect(f.files).toEqual(['apps/a.ts', 'packages/b.ts', 'c.ts']);
    expect(f.summary).toBe(
      'Rebase conflict in apps/a.ts, packages/b.ts +1 more'
    );
  });

  test('a rebase conflict without files falls back to the commit git stopped on', () => {
    // Verbatim shape of a real reason: git's progress line ends in \r, not \n.
    const f = failed(
      'git rebase failed: Rebasing (1/1)\rerror: could not apply 71fc32854... feat(desktop): Let the side panel hide\nhint: Resolve all conflicts manually'
    );
    expect(f.kind).toBe('rebase-conflict');
    expect(f.files).toBeUndefined();
    expect(f.summary).toBe(
      'Rebase conflict applying 71fc32854 feat(desktop): Let the side panel hide'
    );
  });

  test('an older reason that carried stdout still yields its CONFLICT paths', () => {
    const f = failed(
      'git rebase failed: CONFLICT (content): Merge conflict in src/x.ts\nCONFLICT (content): Merge conflict in src/y.ts'
    );
    expect(f.files).toEqual(['src/x.ts', 'src/y.ts']);
  });

  test('a verify timeout names the step and the ceiling', () => {
    const f = failed(
      'typecheck timed out after 900s — raise orchestrator.verifyTimeoutSec or narrow the step'
    );
    expect(f).toMatchObject({
      kind: 'verify-timeout',
      stage: 'verifying',
      step: 'typecheck',
      summary: 'typecheck timed out after 900s',
    });
  });

  test('a failed moon step reads its exit code and drops a target that repeats the step', () => {
    const f = failed(
      'lint-deadcode failed: desktop:build | \u001b[33m[INEFFECTIVE_DYNAMIC_IMPORT]\u001b[0m\nroot:lint-deadcode | Configuration hints (1)\n\ntask_runner::run_failed\n\n  × Task root:lint-deadcode failed to run.\n  ╰─▶ Process knip failed: exit code 1'
    );
    expect(f).toMatchObject({
      kind: 'verify-failed',
      step: 'lint-deadcode',
      exitCode: 1,
      summary: 'lint-deadcode failed · exit 1',
    });
  });

  test('a step whose moon target differs from its name keeps the target', () => {
    const f = failed(
      'build failed: × Task desktop:build failed to run.\n╰─▶ Process vite failed: exit code 2'
    );
    expect(f.summary).toBe('build failed · desktop:build · exit 2');
  });

  test('an unknown moon task is called out, not reported as a lint failure', () => {
    const f = failed(
      'lint-chrome failed: Error: project::unknown_task\n\n  × Unknown task lint-chrome for project root.\n  help: Has this task been configured?'
    );
    expect(f).toMatchObject({
      kind: 'unknown-task',
      step: 'lint-chrome',
      summary: 'lint-chrome: unknown moon task root:lint-chrome',
    });
  });

  test.each([
    [
      "git fetch failed: fatal: couldn't find remote ref epic/e-1",
      'fetch-failed',
      'rebasing',
    ],
    ['git push failed: rejected', 'merge-failed', 'merging'],
    ['gh pr merge failed: not mergeable', 'merge-failed', 'merging'],
    [
      'worktree is gone: /w/r-1 — the branch b still exists',
      'worktree-gone',
      'rebasing',
    ],
    [
      "the run's worktree has uncommitted changes, so it cannot be rebased.",
      'worktree-dirty',
      'rebasing',
    ],
    [
      'the run this one was stacked on was discarded — rebase it',
      'base-discarded',
      'queued',
    ],
    ['run no longer exists: r-1', 'run-gone', 'queued'],
    ['run was already reviewed outside the merge queue', 'run-gone', 'queued'],
  ] as const)('%s → %s', (reason, kind, stage) => {
    const f = failed(reason);
    expect(f.kind).toBe(kind);
    expect(f.stage).toBe(stage);
  });

  test('anything unrecognised shows its first line, at the failed step when there is one', () => {
    const f = failed('\n\nsomething odd happened\nmore', {
      steps: [
        { name: 'install', status: 'passed' },
        { name: 'test', status: 'failed' },
      ],
    });
    expect(f).toMatchObject({
      kind: 'unknown',
      stage: 'verifying',
      step: 'test',
      summary: 'something odd happened',
    });
    expect(failed('').summary).toBe('Failed — no reason recorded');
  });
});

describe('buildLandingBoard', () => {
  test('a null snapshot is an empty board', () => {
    const empty = buildLandingBoard(null, [], DEFAULT_STATUS_MODEL, NOW);
    expect(empty).toEqual({ inProgress: [], failed: [], landedToday: [] });
  });

  test('live entries are in progress, in queue order, with their positions', () => {
    const b = board({
      entries: [
        entry({ runId: 'r-a', taskId: 't-a', state: 'verifying' }),
        entry({ runId: 'r-b', taskId: 't-b' }),
      ],
    });
    expect(b.inProgress.map((i) => [i.entry.runId, i.position])).toEqual([
      ['r-a', 1],
      ['r-b', 2],
    ]);
    expect(b.inProgress[0]?.since).toBe(at(10));
  });

  test('the stage track marks earlier stages passed and the current one active', () => {
    const b = board({ entries: [entry({ state: 'verifying' })] });
    expect(b.inProgress[0]?.steps.map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'active',
      'pending',
    ]);
  });

  test('a failure marks the stage it stopped in, and the elapsed clock reads from finishedAt', () => {
    const b = board({
      history: [
        entry({
          state: 'failed',
          reason: 'typecheck failed: boom',
          finishedAt: at(2),
        }),
      ],
    });
    const item = b.failed[0];
    expect(item?.steps.map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'failed',
      'pending',
    ]);
    expect(item?.since).toBe(at(2));
    expect(item?.position).toBeNull();
  });

  test('one row per task: a requeued run supersedes its own earlier failure', () => {
    const b = board({
      entries: [entry({ runId: 'r-1', taskId: 't-1' })],
      history: [entry({ runId: 'r-1', taskId: 't-1', state: 'failed' })],
    });
    expect(b.inProgress).toHaveLength(1);
    expect(b.failed).toHaveLength(0);
  });

  test('a task that landed after an earlier failure is not failed any more', () => {
    const b = board({
      history: [
        entry({ runId: 'r-2', state: 'merged', finishedAt: at(5) }),
        entry({ runId: 'r-1', state: 'failed', finishedAt: at(50) }),
      ],
    });
    expect(b.landedToday.map((i) => i.entry.runId)).toEqual(['r-2']);
    expect(b.failed).toHaveLength(0);
  });

  test('landed today is bounded by local midnight, not the last 24 hours', () => {
    const midnight = new Date(2026, 10, 8, 0, 0, 0).getTime();
    const b = board({
      history: [
        entry({
          runId: 'r-today',
          taskId: 't-today',
          state: 'merged',
          finishedAt: new Date(midnight + 1000).toISOString(),
        }),
        entry({
          runId: 'r-yesterday',
          taskId: 't-yesterday',
          state: 'merged',
          finishedAt: new Date(midnight - 1000).toISOString(),
        }),
      ],
    });
    expect(b.landedToday.map((i) => i.entry.runId)).toEqual(['r-today']);
  });

  test('an older failure is still shown — it needs action whatever day it was', () => {
    const b = board({
      history: [
        entry({ state: 'failed', finishedAt: at(60 * 48), reason: 'x' }),
      ],
    });
    expect(b.failed).toHaveLength(1);
  });

  test('a run waiting on blockers names each unfinished blocker and where its run is', () => {
    const b = board(
      {
        entries: [
          entry({
            runId: 'r-config',
            taskId: 't-config',
            state: 'verifying',
          }),
          entry({
            runId: 'r-dep',
            taskId: 't-dep',
            state: 'waiting-blockers',
          }),
        ],
      },
      [
        task('t-config', { title: 'Landing-mode config' }),
        task('t-dep', { blockedBy: ['t-config', 't-done', 't-unqueued'] }),
        task('t-done', { status: 'done' }),
        task('t-unqueued', { title: 'Docs pass' }),
      ]
    );
    const dep = b.inProgress[1];
    expect(dep?.waitingOn).toEqual([
      {
        taskId: 't-config',
        title: 'Landing-mode config',
        runId: 'r-config',
        stage: 'verifying',
        position: 1,
      },
      {
        taskId: 't-unqueued',
        title: 'Docs pass',
        runId: null,
        stage: null,
        position: null,
      },
    ]);
    expect(dep?.hold).toEqual({
      kind: 'blockers',
      detail:
        'Waiting on Landing-mode config (#1 · verifying), Docs pass (not queued)',
    });
  });

  test('blockers are only listed while the queue says the entry waits on them', () => {
    const b = board({ entries: [entry({ taskId: 't-dep' })] }, [
      task('t-dep', { blockedBy: ['t-x'] }),
      task('t-x'),
    ]);
    expect(b.inProgress[0]?.waitingOn).toEqual([]);
    expect(b.inProgress[0]?.hold).toBeNull();
  });

  test('environment and GitHub holds carry the reason the queue gave', () => {
    const b = board({
      entries: [
        entry({
          runId: 'r-env',
          taskId: 't-env',
          state: 'blocked-environment',
          reason: 'main checkout has uncommitted changes\nM file.ts',
        }),
        entry({
          runId: 'r-gh',
          taskId: 't-gh',
          state: 'waiting-github',
          reason: 'waiting on CI (2 running)',
        }),
      ],
    });
    expect(b.inProgress.map((i) => i.hold)).toEqual([
      {
        kind: 'environment',
        detail: 'main checkout has uncommitted changes',
      },
      { kind: 'github', detail: 'GitHub: waiting on CI (2 running)' },
    ]);
  });
});

describe('landingSections', () => {
  const b = board({
    entries: [entry({ runId: 'r-live', taskId: 't-live' })],
    history: [
      entry({
        runId: 'r-bad',
        taskId: 't-bad',
        state: 'failed',
        finishedAt: at(1),
      }),
    ],
  });

  test('all shows failures first and leaves empty sections out', () => {
    expect(
      landingSections(b, 'all').map((s) => [s.id, s.items.length])
    ).toEqual([
      ['failed', 1],
      ['in-progress', 1],
    ]);
  });

  test('a single filter keeps its section even when empty', () => {
    expect(landingSections(b, 'landed-today')).toEqual([
      { id: 'landed-today', label: 'Landed today', items: [] },
    ]);
  });
});

describe('row helpers', () => {
  test('formatStageElapsed', () => {
    expect(formatStageElapsed(at(0), NOW)).toBe('0s');
    expect(formatStageElapsed(new Date(NOW - 42_000).toISOString(), NOW)).toBe(
      '42s'
    );
    expect(formatStageElapsed(at(4), NOW)).toBe('4m');
    expect(formatStageElapsed(at(60), NOW)).toBe('1h');
    expect(formatStageElapsed(at(65), NOW)).toBe('1h 5m');
    expect(formatStageElapsed(at(60 * 50), NOW)).toBe('2d');
    expect(formatStageElapsed('not a date', NOW)).toBe('—');
  });

  test('formatFiles', () => {
    expect(formatFiles(['a'])).toBe('a');
    expect(formatFiles(['a', 'b'])).toBe('a, b');
    expect(formatFiles(['a', 'b', 'c', 'd'])).toBe('a, b +2 more');
  });

  test('stageDetail reports the running verify step', () => {
    const b = board({
      entries: [
        entry({
          state: 'verifying',
          steps: [
            { name: 'install', status: 'passed' },
            { name: 'typecheck', status: 'running' },
            { name: 'test', status: 'pending' },
          ],
        }),
      ],
    });
    const item = b.inProgress[0];
    expect(item === undefined ? null : stageDetail(item)).toBe(
      'typecheck · 1/3'
    );
  });

  test('only a queued entry can be pulled; the one being processed cannot', () => {
    const b = board({
      entries: [
        entry({ runId: 'r-a', taskId: 't-a', state: 'rebasing' }),
        entry({ runId: 'r-b', taskId: 't-b', state: 'waiting-blockers' }),
      ],
      history: [entry({ runId: 'r-c', taskId: 't-c', state: 'failed' })],
    });
    expect(b.inProgress.map(canPullFromQueue)).toEqual([false, true]);
    expect(b.failed.map(canPullFromQueue)).toEqual([false]);
  });
});

describe('landingMark', () => {
  test('a hold you must clear is amber, a failure red, work blue', () => {
    const b = board({
      entries: [
        entry({ runId: 'r-1', taskId: 't-1', state: 'blocked-environment' }),
        entry({ runId: 'r-2', taskId: 't-2', state: 'waiting-blockers' }),
        entry({ runId: 'r-3', taskId: 't-3', state: 'waiting-github' }),
        entry({ runId: 'r-4', taskId: 't-4', state: 'verifying' }),
        entry({ runId: 'r-5', taskId: 't-5' }),
      ],
      history: [
        entry({ runId: 'r-6', taskId: 't-6', state: 'failed' }),
        entry({
          runId: 'r-7',
          taskId: 't-7',
          state: 'merged',
          finishedAt: at(1),
        }),
      ],
    });
    expect(
      [...b.inProgress, ...b.failed, ...b.landedToday].map(landingMark)
    ).toEqual([
      'unblock',
      'blocked',
      'checking',
      'working',
      'landing',
      'failed',
      'landing',
    ]);
  });
});
