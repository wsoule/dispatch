import type {
  EpicProgress,
  EpicProgressChild,
  RunMeta,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildLiveRail } from './liveRail';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function child(id: string): EpicProgressChild {
  return {
    id,
    title: id,
    status: 'working',
    phase: 'working',
    wave: 1,
    openFindings: 0,
  };
}

function session(epicId: string, childIds: string[]): EpicProgress {
  return {
    epicId,
    active: true,
    concurrency: 2,
    session: {
      epicId,
      concurrency: 2,
      executor: 'claude',
      state: 'active',
      maxSpendUsd: 60,
      maxRuns: null,
      startedAt: '2026-08-04T00:00:00.000Z',
      startedBy: null,
      scope: 'plan',
      updatedAt: '2026-08-04T00:00:00.000Z',
      active: true,
    },
    spend: {
      settledUsd: 41.2,
      liveCount: childIds.length,
      estimatedLiveUsd: 10 * childIds.length,
      runsStarted: childIds.length,
      maxSpendUsd: 60,
      maxRuns: null,
    },
    children: childIds.map(child),
    waves: [],
    liveRuns: [],
  };
}

describe('buildLiveRail', () => {
  test('a running execute run appears labeled agent', () => {
    expect(buildLiveRail([run()])).toEqual({
      groups: [],
      rows: [{ run: run(), kindLabel: 'agent' }],
    });
  });

  test('a running review run appears labeled review', () => {
    expect(buildLiveRail([run({ kind: 'review' })]).rows).toEqual([
      { run: run({ kind: 'review' }), kindLabel: 'review' },
    ]);
  });

  test('a running verify run appears labeled verify', () => {
    expect(
      buildLiveRail([run({ kind: 'verify' })]).rows.map((row) => row.kindLabel)
    ).toEqual(['verify']);
  });

  test('terminal runs are excluded', () => {
    expect(buildLiveRail([run({ state: 'finished' })]).rows).toHaveLength(0);
  });

  test('rows keep the input order', () => {
    const { rows } = buildLiveRail([
      run({ id: 'r-a', state: 'awaiting-approval' }),
      run({ id: 'r-b', state: 'running' }),
      run({ id: 'r-done', state: 'finished' }),
    ]);
    expect(rows.map((row) => row.run.id)).toEqual(['r-a', 'r-b']);
  });

  test('live runs on a session child group under that session', () => {
    const progress = session('e-1', ['t-1', 't-2']);
    const { groups, rows } = buildLiveRail(
      [
        run({ id: 'r-1', taskId: 't-1' }),
        run({ id: 'r-9', taskId: 't-9' }),
        run({ id: 'r-2', taskId: 't-2', kind: 'review' }),
      ],
      [progress]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.progress).toBe(progress);
    expect(groups[0]?.rows.map((row) => row.run.id)).toEqual(['r-1', 'r-2']);
    expect(groups[0]?.rows.map((row) => row.kindLabel)).toEqual([
      'agent',
      'review',
    ]);
    // The run outside every session is the loose tail.
    expect(rows.map((row) => row.run.id)).toEqual(['r-9']);
  });

  test('a session with no live run is omitted', () => {
    const { groups, rows } = buildLiveRail(
      [run({ id: 'r-1', taskId: 't-1', state: 'finished' })],
      [session('e-1', ['t-1']), session('e-2', ['t-2'])]
    );
    expect(groups).toEqual([]);
    expect(rows).toEqual([]);
  });

  test('groups follow the sessions order; the tail follows the runs order', () => {
    const { groups, rows } = buildLiveRail(
      [
        run({ id: 'r-b', taskId: 't-b' }),
        run({ id: 'r-loose-2', taskId: 't-x' }),
        run({ id: 'r-a', taskId: 't-a' }),
        run({ id: 'r-loose-1', taskId: 't-y' }),
      ],
      [session('e-a', ['t-a']), session('e-b', ['t-b'])]
    );
    expect(groups.map((group) => group.progress.epicId)).toEqual([
      'e-a',
      'e-b',
    ]);
    expect(rows.map((row) => row.run.id)).toEqual(['r-loose-2', 'r-loose-1']);
  });

  test('no sessions argument leaves every row loose', () => {
    const { groups, rows } = buildLiveRail([run()]);
    expect(groups).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});
