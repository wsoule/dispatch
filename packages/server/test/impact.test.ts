import { expect, test } from 'bun:test';

import type { DepMap } from '../src/depmap.js';
import { computeImpact, type ImpactDeps } from '../src/impact.js';

const depMap: DepMap = {
  dependents: (f) => (f === 'src/db.ts' ? ['src/api.ts'] : []),
  dependentsWithHops: () => [],
  mirrors: () => [],
  reach: () => {
    throw new Error('replaced below');
  },
};

function deps(over: Partial<ImpactDeps> = {}): ImpactDeps {
  return {
    rootDir: '/repo',
    depMap: () => ({
      ...depMap,
      reach: () => ({
        entries: [{ path: 'src/api.ts', hops: 1 }],
        count: 1,
        maxHops: 1,
        sources: ['scanner'],
        degraded: false,
        truncated: false,
      }),
    }),
    changedFilesForRun: () => null,
    writesForTask: () => null,
    trackedFiles: () => ['src/db.ts', 'src/api.ts'],
    fileExists: () => false,
    ...over,
  };
}

test('a file subject seeds itself', () => {
  const result = computeImpact({ kind: 'file', path: 'src/db.ts' }, deps());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.seeds).toEqual(['src/db.ts']);
});

test('a path escaping the repo root is rejected before touching the graph', () => {
  const result = computeImpact(
    { kind: 'file', path: '../../etc/passwd' },
    deps()
  );
  expect(result).toEqual({ ok: false, reason: 'outside-root' });
});

test('a run subject seeds its changed files', () => {
  const result = computeImpact(
    { kind: 'run', runId: 'r-1' },
    deps({ changedFilesForRun: () => ['src/db.ts'] })
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.seeds).toEqual(['src/db.ts']);
});

test('an unknown run is not-found, not an empty result', () => {
  const result = computeImpact({ kind: 'run', runId: 'nope' }, deps());
  expect(result).toEqual({ ok: false, reason: 'not-found' });
});

test('a task subject expands its declared write globs against tracked files', () => {
  const result = computeImpact(
    { kind: 'task', taskId: 't-1' },
    deps({ writesForTask: () => ['src/*.ts'] })
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.seeds.sort()).toEqual(['src/api.ts', 'src/db.ts']);
});

test('a task with no declared writes says so rather than guessing', () => {
  const result = computeImpact(
    { kind: 'task', taskId: 't-1' },
    deps({ writesForTask: () => [] })
  );
  expect(result).toEqual({ ok: false, reason: 'no-declared-writes' });
});

test('a task whose declared writes match no tracked file says so, not a false empty', () => {
  const result = computeImpact(
    { kind: 'task', taskId: 't-1' },
    deps({ writesForTask: () => ['packages/newthing/**'] })
  );
  expect(result).toEqual({ ok: false, reason: 'writes-match-nothing' });
});

test('a file subject that is neither tracked nor present on disk is not-found', () => {
  const result = computeImpact(
    { kind: 'file', path: 'src/db/clint.ts' },
    deps({ trackedFiles: () => ['src/db/client.ts'], fileExists: () => false })
  );
  expect(result).toEqual({ ok: false, reason: 'not-found' });
});

test('a tracked-but-deleted file is still a valid subject', () => {
  const result = computeImpact(
    { kind: 'file', path: 'src/db.ts' },
    deps({ trackedFiles: () => ['src/db.ts'], fileExists: () => false })
  );
  expect(result.ok).toBe(true);
});

test('an untracked-but-present file is still a valid subject', () => {
  const result = computeImpact(
    { kind: 'file', path: 'src/new.ts' },
    deps({ trackedFiles: () => [], fileExists: () => true })
  );
  expect(result.ok).toBe(true);
});

test('reach is called with the resolved seeds, not an unrelated empty array', () => {
  const calls: string[][] = [];
  const result = computeImpact(
    { kind: 'task', taskId: 't-1' },
    deps({
      writesForTask: () => ['src/*.ts'],
      depMap: () => ({
        ...depMap,
        reach: (files: string[]) => {
          calls.push(files);
          return {
            entries: [],
            count: 0,
            maxHops: 0,
            sources: ['scanner'],
            degraded: false,
            truncated: false,
          };
        },
      }),
    })
  );
  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect([...calls[0]].sort()).toEqual(['src/api.ts', 'src/db.ts']);
});
