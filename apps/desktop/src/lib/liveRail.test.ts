import type { RunMeta, RunQuestion } from '@dispatch/client';
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

const NO_QUESTIONS = new Map<string, RunQuestion[]>();

describe('buildLiveRail', () => {
  test('a running execute run appears labeled agent', () => {
    const rail = buildLiveRail([run()], [], NO_QUESTIONS);
    expect(rail.live).toEqual([{ run: run(), kindLabel: 'agent' }]);
  });

  test('a running review run appears labeled review', () => {
    const rail = buildLiveRail([run({ kind: 'review' })], [], NO_QUESTIONS);
    expect(rail.live).toEqual([
      { run: run({ kind: 'review' }), kindLabel: 'review' },
    ]);
  });

  test('a running verify run appears labeled verify', () => {
    const rail = buildLiveRail([run({ kind: 'verify' })], [], NO_QUESTIONS);
    expect(rail.live.map((row) => row.kindLabel)).toEqual(['verify']);
  });

  test('terminal runs are excluded from live', () => {
    const rail = buildLiveRail([run({ state: 'finished' })], [], NO_QUESTIONS);
    expect(rail.live).toHaveLength(0);
  });

  test('attentionCount equals buildInbox review + waiting lengths', () => {
    const runs = [
      run({ id: 'r-review', state: 'finished' }),
      run({ id: 'r-waiting', state: 'awaiting-approval' }),
      run({ id: 'r-live', state: 'running' }),
    ];
    const rail = buildLiveRail(runs, [], NO_QUESTIONS);
    // r-review -> review (1), r-waiting -> waiting (1) => 2
    expect(rail.attentionCount).toBe(2);
    expect(rail.live.map((row) => row.run.id)).toEqual(['r-waiting', 'r-live']);
  });
});
