import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { RunQuestion, RunScopeRequest } from './gates';
import {
  askRunIdsForChat,
  newestScopeRequestOf,
  questionsOfRuns,
  taskIdsWithOpenAsks,
} from './taskAsks';

function run(id: string, over: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    taskId: 't-1',
    taskTitle: 'Checkout',
    executor: 'claude',
    state: 'finished',
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/wt/${id}`,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...over,
  };
}

function question(id: string, runId: string, askedAt: string): RunQuestion {
  return {
    id,
    runId,
    question: `question ${id}`,
    options: [],
    askedAt,
    answer: null,
    answeredAt: null,
  };
}

function scope(
  id: string,
  runId: string,
  requestedAt: string
): RunScopeRequest {
  return {
    id,
    runId,
    paths: ['a.ts'],
    reason: 'needs it',
    requestedAt,
    granted: null,
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
  };
}

describe('askRunIdsForChat', () => {
  // An ended execute run's question stays open for its task, so the task's
  // chat shows it whichever of the task's runs is selected.
  test("the selected run plus the task's ended execute runs", () => {
    const runs = [
      run('r-new', { state: 'running' }),
      run('r-old', { state: 'failed' }),
      run('r-live-other', { state: 'running' }),
      run('r-review', { kind: 'review' }),
      run('r-elsewhere', { taskId: 't-2' }),
    ];
    expect(askRunIdsForChat(runs, runs[0])).toEqual(['r-new', 'r-old']);
  });

  test('an ended selected run is listed once', () => {
    const runs = [run('r-1'), run('r-0')];
    expect(askRunIdsForChat(runs, runs[0])).toEqual(['r-1', 'r-0']);
  });
});

describe('questionsOfRuns', () => {
  test("merges the runs' open questions, oldest first", () => {
    const byRun = new Map([
      ['r-new', [question('q-2', 'r-new', '2026-09-26T00:02:00Z')]],
      ['r-old', [question('q-1', 'r-old', '2026-09-26T00:01:00Z')]],
      ['r-x', [question('q-x', 'r-x', '2026-09-26T00:00:00Z')]],
    ]);
    expect(questionsOfRuns(byRun, ['r-new', 'r-old']).map((q) => q.id)).toEqual(
      ['q-1', 'q-2']
    );
  });
});

describe('newestScopeRequestOf', () => {
  test('picks the newest open scope gate across the runs, or null', () => {
    const byRun = new Map([
      ['r-old', scope('m-1', 'r-old', '2026-09-26T00:01:00Z')],
      ['r-new', scope('m-2', 'r-new', '2026-09-26T00:02:00Z')],
    ]);
    expect(newestScopeRequestOf(byRun, ['r-old', 'r-new'])?.id).toBe('m-2');
    expect(newestScopeRequestOf(byRun, ['r-none'])).toBeNull();
  });
});

describe('taskIdsWithOpenAsks', () => {
  // Liveness does not matter: an ended run's question waits for the task.
  test('a task asks while any of its runs has an open question or scope gate', () => {
    const runs = [
      run('r-1', { state: 'failed' }),
      run('r-2', { taskId: 't-2', state: 'finished' }),
      run('r-3', { taskId: 't-3', state: 'running' }),
    ];
    const asks = taskIdsWithOpenAsks(
      runs,
      new Map([['r-1', [question('q-1', 'r-1', '2026-09-26T00:00:00Z')]]]),
      new Map([['r-2', scope('m-2', 'r-2', '2026-09-26T00:00:00Z')]])
    );
    expect([...asks].sort()).toEqual(['t-1', 't-2']);
  });
});
