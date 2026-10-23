import { describe, expect, test } from 'bun:test';

import { type DagTask, dagWaves } from './dagLayout';

// dagWaves takes its own minimal `DagTask` shape rather than a full TaskDoc, so the fixture
// is exactly the fields the layering reads.
function makeTask(
  id: string,
  blockedBy: string[] = [],
  created = '2026-01-01T00:00:00.000Z',
  status = 'ready'
): DagTask {
  return { id, title: `Task ${id}`, status, created, blockedBy };
}

describe('dagWaves', () => {
  const t = (id: string, blockedBy: string[] = []) => ({
    id,
    title: id,
    status: 'ready',
    created: '2026-01-01',
    blockedBy,
  });

  test('a task’s wave is one past its deepest blocker', () => {
    const waves = dagWaves([t('a'), t('b', ['a']), t('c', ['a', 'b']), t('d')]);
    expect(Object.fromEntries(waves)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  test('a set with no edges is a single wave', () => {
    const waves = dagWaves(Array.from({ length: 12 }, (_, i) => t(`t${i}`)));
    expect(new Set(waves.values())).toEqual(new Set([0]));
  });

  test('blockers outside the set and self-references are ignored', () => {
    const waves = dagWaves([t('a', ['a', 'outside'])]);
    expect(waves.get('a')).toBe(0);
  });

  test('a cycle still gives every task a wave, the same in any input order', () => {
    const tasks = [t('a', ['c']), t('b', ['a']), t('c', ['b']), t('d', ['c'])];
    const waves = Object.fromEntries(dagWaves(tasks));
    expect(Object.keys(waves).sort()).toEqual(['a', 'b', 'c', 'd']);
    for (const wave of Object.values(waves)) {
      expect(Number.isFinite(wave)).toBe(true);
    }
    expect(Object.fromEntries(dagWaves([...tasks].reverse()))).toEqual(waves);
  });
});

describe('wave cost', () => {
  // A seeded random DAG: each node waits on up to three earlier ones.
  function randomDag(n: number): DagTask[] {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    return Array.from({ length: n }, (_, i) => {
      const blockers = new Set<string>();
      for (let k = 0; k < 3 && i > 0; k++) {
        blockers.add(`t${Math.floor(rand() * i)}`);
      }
      return makeTask(
        `t${i}`,
        [...blockers],
        `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`
      );
    });
  }

  // Generous budgets: these guard against quadratic blow-ups, not machine speed.
  test.each([
    [64, 50],
    [200, 100],
    [600, 300],
    [2000, 1500],
  ])('%p nodes get their waves in under %pms', (n, budget) => {
    const tasks = randomDag(n);
    const start = performance.now();
    const waves = dagWaves(tasks);
    expect(performance.now() - start).toBeLessThan(budget);
    expect(waves.size).toBe(n);
  });
});
