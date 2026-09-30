import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  criticalPath,
  DEFAULT_RUN_MS,
  edgeKey,
  etaMs,
  formatDuration,
  type PathNode,
  runPace,
} from './criticalPath';

const MIN = 60_000;

function run(
  id: string,
  minutes: number,
  extra: Partial<RunMeta> = {}
): RunMeta {
  const start = Date.parse('2026-09-20T10:00:00Z') + Number(id.slice(1)) * 1000;
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: id,
    executor: 'claude',
    state: 'finished',
    branch: '',
    baseBranch: 'main',
    worktreePath: '',
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start + minutes * MIN).toISOString(),
    ...extra,
  };
}

describe('runPace', () => {
  test('the median of finished agent runs', () => {
    expect(runPace([run('r1', 10), run('r2', 30), run('r3', 20)])).toEqual({
      medianMs: 20 * MIN,
      samples: 3,
    });
  });

  test('falls back to the default without enough clean samples', () => {
    expect(
      runPace([
        run('r1', 10),
        run('r2', 30),
        // Reviewed: its updatedAt is the review, not the finish.
        run('r3', 600, { reviewedAt: '2026-09-21T00:00:00Z' }),
        run('r4', 12, { kind: 'review' }),
        run('r5', 12, { state: 'failed' }),
      ])
    ).toEqual({ medianMs: DEFAULT_RUN_MS, samples: 0 });
  });
});

// a → c → d, b → d: the chain through c is the longer one.
function nodes(overrides: Partial<Record<string, Partial<PathNode>>> = {}) {
  const base: PathNode[] = [
    { id: 'a', wave: 0, blockedBy: [], state: 'queued' },
    { id: 'b', wave: 0, blockedBy: [], state: 'queued' },
    { id: 'c', wave: 1, blockedBy: ['a'], state: 'blocked' },
    { id: 'd', wave: 2, blockedBy: ['c', 'b'], state: 'blocked' },
  ];
  return base.map((n) => ({ ...n, ...overrides[n.id] }));
}

describe('criticalPath', () => {
  test('the heaviest remaining chain, blockers first', () => {
    const path = criticalPath(nodes(), 10 * MIN, 0);
    expect(path.ids).toEqual(['a', 'c', 'd']);
    expect(path.ms).toBe(30 * MIN);
    expect(path.workMs).toBe(40 * MIN);
    expect([...path.edges]).toEqual([edgeKey('a', 'c'), edgeKey('c', 'd')]);
  });

  test('a running node counts only what is left of its median', () => {
    const now = Date.parse('2026-09-20T10:08:00Z');
    const path = criticalPath(
      nodes({
        a: { state: 'running', startedAt: Date.parse('2026-09-20T10:00:00Z') },
      }),
      10 * MIN,
      now
    );
    expect(path.ms).toBe(22 * MIN);
  });

  test('a landed or in-review blocker releases the chain behind it', () => {
    const path = criticalPath(
      nodes({ a: { state: 'done' }, c: { state: 'review' } }),
      10 * MIN,
      0
    );
    expect(path.ids).toEqual(['b', 'd']);
    expect(path.ms).toBe(20 * MIN);
  });

  test('nothing left is an empty path', () => {
    const done = nodes().map((n) => ({ ...n, state: 'done' as const }));
    expect(criticalPath(done, 10 * MIN, 0)).toMatchObject({
      ids: [],
      ms: 0,
      workMs: 0,
    });
  });
});

describe('etaMs', () => {
  test('the path, or the load over the slots when that is longer', () => {
    const path = criticalPath(nodes(), 10 * MIN, 0);
    expect(etaMs(path, 4)).toBe(30 * MIN);
    expect(etaMs(path, 1)).toBe(40 * MIN);
    expect(etaMs(path, null)).toBeNull();
  });
});

test('formatDuration', () => {
  expect(formatDuration(20_000)).toBe('<1m');
  expect(formatDuration(25 * MIN)).toBe('~25m');
  expect(formatDuration(100 * MIN)).toBe('~1h 40m');
  expect(formatDuration(120 * MIN)).toBe('~2h');
  expect(formatDuration(26 * 60 * MIN)).toBe('~1d 2h');
});
