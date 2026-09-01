import type { RunMeta } from '@dispatch/client';
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

describe('buildLiveRail', () => {
  test('a running execute run appears labeled agent', () => {
    expect(buildLiveRail([run()])).toEqual([
      { run: run(), kindLabel: 'agent' },
    ]);
  });

  test('a running review run appears labeled review', () => {
    expect(buildLiveRail([run({ kind: 'review' })])).toEqual([
      { run: run({ kind: 'review' }), kindLabel: 'review' },
    ]);
  });

  test('a running verify run appears labeled verify', () => {
    expect(
      buildLiveRail([run({ kind: 'verify' })]).map((row) => row.kindLabel)
    ).toEqual(['verify']);
  });

  test('terminal runs are excluded', () => {
    expect(buildLiveRail([run({ state: 'finished' })])).toHaveLength(0);
  });

  test('rows keep the input order', () => {
    const rows = buildLiveRail([
      run({ id: 'r-a', state: 'awaiting-approval' }),
      run({ id: 'r-b', state: 'running' }),
      run({ id: 'r-done', state: 'finished' }),
    ]);
    expect(rows.map((row) => row.run.id)).toEqual(['r-a', 'r-b']);
  });
});
