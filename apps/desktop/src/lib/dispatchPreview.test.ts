import type { TaskDoc } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';

import { buildDispatchPreview } from './dispatchPreview';

function task(id: string, title = `Task ${id}`): TaskDoc {
  return { meta: { id, title } } as TaskDoc;
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
});
