import type { TaskDoc } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import { buildDispatchPreview } from './dispatchPreview';

function task(
  id: string,
  title = `Task ${id}`,
  writes: string[] = [`src/${id}.ts`]
): TaskDoc {
  return { meta: { id, title, writes } } as TaskDoc;
}

const four = [task('t-1'), task('t-2'), task('t-3'), task('t-4')];
const allReady = new Set(['t-1', 't-2', 't-3', 't-4']);

describe('buildDispatchPreview', () => {
  test('fills the free slots and queues the rest', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 1,
      concurrency: 3,
    });
    expect(p.startsNow).toBe(2);
    expect(p.queued).toBe(2);
  });

  // The whole reason the dialog exists. Twelve into eight with five busy must show all twelve.
  test('nothing is ever dropped from the preview', () => {
    const many = Array.from({ length: 12 }, (_, i) => task(`t-${i}`));
    const p = buildDispatchPreview({
      tasks: many,
      readyIds: new Set(many.map((t) => t.meta.id)),
      runningNow: 5,
      concurrency: 8,
    });
    expect(p.rows).toHaveLength(12);
    expect(p.startsNow + p.queued + p.notReady).toBe(12);
    expect(p.startsNow).toBe(3);
    expect(p.queued).toBe(9);
  });

  test('a full pipeline queues everything rather than starting one anyway', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 8,
      concurrency: 8,
    });
    expect(p.startsNow).toBe(0);
    expect(p.queued).toBe(4);
  });

  test('over-subscribed slots never produce a negative budget', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 20,
      concurrency: 4,
    });
    expect(p.startsNow).toBe(0);
    expect(p.queued).toBe(4);
  });

  // Selecting a blocked task is normal — the bar acts on a selection, not a filtered list. It
  // has to be shown as un-startable rather than quietly counted as queued.
  test('tasks that are not ready are called out separately from queued ones', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: new Set(['t-1', 't-2']),
      runningNow: 0,
      concurrency: 10,
    });
    expect(p.startsNow).toBe(2);
    expect(p.queued).toBe(0);
    expect(p.notReady).toBe(2);
    expect(
      p.rows.filter((r) => r.disposition === 'not-ready').map((r) => r.taskId)
    ).toEqual(['t-3', 't-4']);
  });

  test('a not-ready task does not consume a slot', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: new Set(['t-4']),
      runningNow: 0,
      concurrency: 1,
    });
    expect(p.startsNow).toBe(1);
    expect(p.rows.find((r) => r.taskId === 't-4')?.disposition).toBe(
      'starts-now'
    );
  });

  test('order is preserved so the preview matches the dispatch order', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 0,
      concurrency: 2,
    });
    expect(p.rows.map((r) => r.taskId)).toEqual(['t-1', 't-2', 't-3', 't-4']);
    expect(
      p.rows.slice(0, 2).every((r) => r.disposition === 'starts-now')
    ).toBe(true);
  });

  // A zero would silently start nothing while the button claimed otherwise.
  test('a nonsensical concurrency is clamped to at least one', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 0,
      concurrency: 0,
    });
    expect(p.startsNow).toBe(1);
  });

  test('an empty selection says so rather than rendering an empty sentence', () => {
    const p = buildDispatchPreview({
      tasks: [],
      readyIds: allReady,
      runningNow: 0,
      concurrency: 4,
    });
    expect(p.rows).toEqual([]);
    expect(p.summary).toBe('Nothing selected.');
  });

  test('a selection of only blocked tasks explains why nothing will happen', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: new Set(),
      runningNow: 0,
      concurrency: 4,
    });
    expect(p.summary).toContain('blocked or already running');
  });

  test('the summary states the arithmetic the user would otherwise do', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 1,
      concurrency: 3,
    });
    expect(p.summary).toContain('1 already running');
    expect(p.summary).toContain('2 start');
    expect(p.summary).toContain('2 queue');
  });

  test('the estimate is $5–15 per run about to start, queued runs included', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 1,
      concurrency: 3,
    });
    expect(p.estimateUsd).toEqual({ low: 20, high: 60 });
    expect(p.summary).toEndWith('~$20–$60 at $5–15 per run');
  });

  // Not-ready tasks never run, so they cost nothing; a different midpoint scales the range.
  test('the estimate skips not-ready tasks and follows the per-run midpoint', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: new Set(['t-1', 't-2']),
      runningNow: 0,
      concurrency: 10,
      runCostEstimateUsd: 20,
    });
    expect(p.estimateUsd).toEqual({ low: 20, high: 60 });
    expect(p.summary).toContain('at $10–30 per run');
  });

  test('a ceiling is spelled out and compared against the low estimate', () => {
    const under = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 0,
      concurrency: 4,
      ceilingUsd: 20,
    });
    expect(under.summary).toEndWith('~$20–$60 at $5–15 per run · ceiling $20');
    expect(under.overCeiling).toBe(false);

    const over = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 0,
      concurrency: 4,
      ceilingUsd: 19.5,
    });
    expect(over.summary).toEndWith('ceiling $19.50');
    expect(over.overCeiling).toBe(true);
  });

  test('a null ceiling means none: no ceiling clause, never over it', () => {
    const p = buildDispatchPreview({
      tasks: four,
      readyIds: allReady,
      runningNow: 0,
      concurrency: 4,
      ceilingUsd: null,
    });
    expect(p.summary).not.toContain('ceiling');
    expect(p.overCeiling).toBe(false);
  });

  test('large estimates print with thousands separators', () => {
    const many = Array.from({ length: 130 }, (_, i) => task(`t-${i}`));
    const p = buildDispatchPreview({
      tasks: many,
      readyIds: new Set(many.map((t) => t.meta.id)),
      runningNow: 0,
      concurrency: 8,
      ceilingUsd: 600,
    });
    expect(p.summary).toEndWith('~$650–$1,950 at $5–15 per run · ceiling $600');
    expect(p.costSummary).toBe('~$650–$1,950 at $5–15 per run · ceiling $600');
    expect(p.overCeiling).toBe(true);
  });

  test('only tasks that will run count as undeclared writes', () => {
    const p = buildDispatchPreview({
      tasks: [
        task('t-1'),
        task('t-2', 'Loose', []),
        task('t-3', 'Loose 2', []),
        task('t-4', 'Blocked and loose', []),
      ],
      readyIds: new Set(['t-1', 't-2', 't-3']),
      runningNow: 0,
      concurrency: 2,
    });
    // t-2 starts now and t-3 queues; t-4 cannot start, so it is never serialised.
    expect(p.undeclaredWrites).toBe(2);
  });

  test('an empty selection carries a zero estimate and no undeclared writes', () => {
    const p = buildDispatchPreview({
      tasks: [],
      readyIds: allReady,
      runningNow: 0,
      concurrency: 4,
      ceilingUsd: 50,
    });
    expect(p.estimateUsd).toEqual({ low: 0, high: 0 });
    expect(p.undeclaredWrites).toBe(0);
    expect(p.overCeiling).toBe(false);
    expect(p.summary).toBe('Nothing selected.');
  });
});

describe('overlaps with live runs', () => {
  const t1 = task('t-1', 'Widget', ['src/widget.ts']);

  test("names the teammate whose live run already claims a task's files", () => {
    const p = buildDispatchPreview({
      tasks: [t1],
      readyIds: new Set(['t-1']),
      runningNow: 1,
      concurrency: 3,
      liveClaims: [
        {
          runId: 'r-9',
          taskId: 't-9',
          claims: ['src/widget.ts'],
          dispatchedBy: 'human:ada',
        },
      ],
    });
    expect(p.overlaps).toEqual([
      { taskId: 't-1', taskTitle: 'Widget', runId: 'r-9', holder: 'human:ada' },
    ]);
  });

  test('a live run on the same task is a redispatch, not an overlap', () => {
    const p = buildDispatchPreview({
      tasks: [t1],
      readyIds: new Set(['t-1']),
      runningNow: 1,
      concurrency: 3,
      liveClaims: [{ runId: 'r-1', taskId: 't-1', claims: ['src/widget.ts'] }],
    });
    expect(p.overlaps).toEqual([]);
  });

  test('disjoint files do not overlap', () => {
    const p = buildDispatchPreview({
      tasks: [t1],
      readyIds: new Set(['t-1']),
      runningNow: 1,
      concurrency: 3,
      liveClaims: [{ runId: 'r-9', taskId: 't-9', claims: ['src/other.ts'] }],
    });
    expect(p.overlaps).toEqual([]);
  });

  test('a task that cannot start is not warned about', () => {
    const p = buildDispatchPreview({
      tasks: [t1],
      readyIds: new Set(),
      runningNow: 0,
      concurrency: 3,
      liveClaims: [{ runId: 'r-9', taskId: 't-9', claims: ['src/widget.ts'] }],
    });
    expect(p.overlaps).toEqual([]);
  });
});
