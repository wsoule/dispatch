import { describe, expect, test } from 'bun:test';

import { computeStack } from '../src/graph.js';
import type { TaskDoc } from '../src/types.js';

function mkTask(
  id: string,
  blockedBy: string[] = [],
  created: string = '2026-01-01'
): TaskDoc {
  return {
    meta: {
      id,
      title: id,
      status: 'todo',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy,
      labels: [],
      priority: 'none',
      assignee: 'none',
      created,
      updated: created,
      external: null,
    },
    body: '',
  };
}

describe('computeStack', () => {
  test('linear chain a<-b<-c: order [a,b,c], index of b is 1', () => {
    const tasks = [mkTask('a', []), mkTask('b', ['a']), mkTask('c', ['b'])];
    expect(computeStack(tasks, 'b')).toEqual({
      order: ['a', 'b', 'c'],
      index: 1,
    });
  });

  test('singleton task returns null', () => {
    expect(computeStack([mkTask('a', [])], 'a')).toBeNull();
  });

  test('unknown id returns null', () => {
    expect(computeStack([mkTask('a', [])], 'zzz')).toBeNull();
  });

  test('diamond a<-{b,c}<-d linearizes with a first, d last, b/c by created', () => {
    const tasks = [
      mkTask('a', [], '2026-01-01'),
      mkTask('b', ['a'], '2026-01-02'),
      mkTask('c', ['a'], '2026-01-03'),
      mkTask('d', ['b', 'c'], '2026-01-04'),
    ];
    expect(computeStack(tasks, 'a')).toEqual({
      order: ['a', 'b', 'c', 'd'],
      index: 0,
    });
  });

  test('two disconnected chains never mix', () => {
    const tasks = [
      mkTask('a', []),
      mkTask('b', ['a']),
      mkTask('x', []),
      mkTask('y', ['x']),
    ];
    expect(computeStack(tasks, 'y')).toEqual({ order: ['x', 'y'], index: 1 });
  });

  test('cycle members still get a defined order (created-date fallback, no hang)', () => {
    const tasks = [
      mkTask('a', ['b'], '2026-01-01'),
      mkTask('b', ['a'], '2026-01-02'),
    ];
    const stack = computeStack(tasks, 'a');
    expect(stack?.order).toEqual(['a', 'b']);
  });

  test('dangling blockedBy ids are ignored as edges', () => {
    const tasks = [mkTask('a', ['ghost'])];
    expect(computeStack(tasks, 'a')).toBeNull();
  });

  test('duplicate blockedBy entries do not inflate in-degree (repro)', () => {
    const tasks = [
      mkTask('a', [], '2026-01-01'),
      mkTask('b', ['a'], '2026-01-02'),
      mkTask('c', ['a', 'a'], '2026-01-03'),
      mkTask('d', ['c'], '2026-01-01'),
    ];
    const stack = computeStack(tasks, 'd');
    expect(stack).toEqual({
      order: ['a', 'b', 'c', 'd'],
      index: 3,
    });
  });
});
