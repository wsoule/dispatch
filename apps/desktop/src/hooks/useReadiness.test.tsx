import type { TaskDoc, TaskMeta } from '@dispatch-foo/core/browser';
import type { ApiClient, ReadinessReading } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  applyJudged,
  readinessFor,
  specChanged,
  useReadiness,
} from './useReadiness';

const reading = (level: ReadinessReading['level']): ReadinessReading => ({
  level,
  label: `level ${level}`,
  confidence: 0.9,
  splitProbability: 0.1,
});

// Only the fields a readiness reading is judged from, plus `updated`.
function doc(
  id: string,
  over: Partial<Pick<TaskMeta, 'title' | 'writes' | 'labels' | 'updated'>> & {
    body?: string;
  } = {}
): TaskDoc {
  const { body = 'Change src/x.ts.', ...meta } = over;
  return {
    meta: {
      id,
      title: 'A task',
      writes: [],
      labels: [],
      updated: '2026-01-01',
      ...meta,
    } as TaskMeta,
    body,
  };
}

describe('applyJudged', () => {
  test('takes each named task’s reading, and drops what came back unjudged', () => {
    expect(
      applyJudged({ 't-1': reading(0), 't-2': reading(1), 't-3': reading(2) }, [
        { id: 't-1', readiness: reading(3) },
        { id: 't-2' },
      ])
    ).toEqual({ 't-1': reading(3), 't-3': reading(2) });
  });
});

describe('specChanged', () => {
  const before = doc('t-1');
  test('a title, body or writes edit is a spec change; a label edit is not', () => {
    const body = before.body;
    expect(specChanged(before.meta, doc('t-1', { labels: ['x'] }), body)).toBe(
      false
    );
    expect(specChanged(before.meta, doc('t-1', { title: 'B' }), body)).toBe(
      true
    );
    expect(specChanged(before.meta, doc('t-1', { body: 'Other.' }), body)).toBe(
      true
    );
    expect(specChanged(before.meta, doc('t-1', { writes: ['a'] }), body)).toBe(
      true
    );
  });

  test('a new task, or one whose body was never seen, counts as changed', () => {
    expect(specChanged(undefined, before, before.body)).toBe(true);
    expect(specChanged(before.meta, before, undefined)).toBe(true);
  });
});

describe('readinessFor', () => {
  test('keeps only readings for tasks still in the ready set', () => {
    const map = readinessFor(
      { 't-1': reading(0), 't-2': reading(3) },
      new Set(['t-2'])
    );
    expect([...map.keys()]).toEqual(['t-2']);
  });
});

// A client whose judging route answers from `answers` in turn (the last one repeats),
// counting judges.
function fakeClient(
  answers: { id: string; readiness?: ReadinessReading }[][],
  cached: Record<string, ReadinessReading> = { 't-1': reading(1) }
) {
  const calls = { judge: 0, cached: 0 };
  const client = {
    fetchReadiness: () => {
      calls.cached += 1;
      return Promise.resolve(cached);
    },
    fetchReadyTaskIds: () => {
      const answer = answers[Math.min(calls.judge, answers.length - 1)];
      calls.judge += 1;
      return Promise.resolve(answer);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

function mount(client: ApiClient, readyIds: ReadonlySet<string>, retry = 20) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(
    ({ ready }: { ready: ReadonlySet<string> }) =>
      useReadiness(client, 1, true, ready, { first: 5, debounce: 20, retry }),
    {
      initialProps: { ready: readyIds },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }
  );
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('useReadiness', () => {
  test('paints the cached reading, then the judged one', async () => {
    const { client, calls } = fakeClient([
      [{ id: 't-1', readiness: reading(3) }],
    ]);
    const { result } = mount(client, new Set(['t-1']));
    await waitFor(() => {
      expect(result.current.readinessById.get('t-1')?.level).toBe(3);
    });
    expect(calls).toEqual({ judge: 1, cached: 1 });
  });

  test('a burst of changes costs one judge', async () => {
    const { client, calls } = fakeClient([
      [{ id: 't-1', readiness: reading(3) }],
    ]);
    const { result } = mount(client, new Set(['t-1']));
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    act(() => {
      for (let i = 0; i < 5; i++) result.current.scheduleJudge();
    });
    await waitFor(() => {
      expect(calls.judge).toBe(2);
    });
    await settle();
    expect(calls.judge).toBe(2);
  });

  // The daemon answers unjudged both without a judgment client and when the judge
  // failed, so one such answer must not end judging for the connection.
  test('an unjudged answer does not stop judging', async () => {
    const { client, calls } = fakeClient(
      [[{ id: 't-1' }], [{ id: 't-1', readiness: reading(0) }]],
      {}
    );
    const { result } = mount(client, new Set(['t-1']));
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    act(() => {
      result.current.scheduleJudge();
    });
    await waitFor(() => {
      expect(result.current.readinessById.get('t-1')?.level).toBe(0);
    });
    expect(calls.judge).toBe(2);
  });

  // A reconnect is likely a restarted daemon, which may have a judgment client now.
  test('a reconnect drops the back-off and judges again soon', async () => {
    const { client, calls } = fakeClient(
      [[{ id: 't-1' }], [{ id: 't-1', readiness: reading(2) }]],
      {}
    );
    const { result } = mount(client, new Set(['t-1']), 60_000);
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    act(() => {
      result.current.scheduleJudge();
    });
    await settle();
    expect(calls.judge).toBe(1);
    act(() => {
      result.current.reconnected();
    });
    await waitFor(() => {
      expect(result.current.readinessById.get('t-1')?.level).toBe(2);
    });
    expect(calls.judge).toBe(2);
  });

  test('answers that judge nothing space the next judge out, doubling', async () => {
    const { client, calls } = fakeClient([[{ id: 't-1' }]], {});
    const { result } = mount(client, new Set(['t-1']), 200);
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    act(() => {
      result.current.scheduleJudge();
    });
    await settle();
    expect(calls.judge).toBe(1);
    await waitFor(() => {
      expect(calls.judge).toBe(2);
    });
    // Twice the wait now.
    act(() => {
      result.current.scheduleJudge();
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.judge).toBe(2);
    await waitFor(() => {
      expect(calls.judge).toBe(3);
    });
  });

  test('an answer drops the reading of a task it names unjudged', async () => {
    const { client, calls } = fakeClient([
      [{ id: 't-1', readiness: reading(0) }],
      [{ id: 't-1' }],
    ]);
    const { result } = mount(client, new Set(['t-1']));
    await waitFor(() => {
      expect(result.current.readinessById.get('t-1')?.level).toBe(0);
    });
    act(() => {
      result.current.scheduleJudge();
    });
    await waitFor(() => {
      expect(calls.judge).toBe(2);
    });
    await waitFor(() => {
      expect(result.current.readinessById.get('t-1')).toBeUndefined();
    });
  });

  // `noteTask` runs before the doc lands in the list; the ready set recomputed from it
  // (a fresh Set on every list change) is what `land` hands the hook.
  test("only an edit to a ready task's spec judges again", async () => {
    const { client, calls } = fakeClient([
      [{ id: 't-1', readiness: reading(3) }],
    ]);
    const { result, rerender } = mount(client, new Set(['t-1']));
    const land = (ready: string[]) => rerender({ ready: new Set(ready) });
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    const first = doc('t-1');
    // The first sight of a body cannot tell an edit from any other change.
    act(() => {
      result.current.noteTask(first.meta, first);
    });
    land(['t-1']);
    await waitFor(() => {
      expect(calls.judge).toBe(2);
    });
    // A label edit, then a task that is not ready: no judge.
    const labelled = doc('t-1', { labels: ['ui'], updated: '2026-01-02' });
    act(() => {
      result.current.noteTask(first.meta, labelled);
      result.current.noteTask(undefined, doc('t-9', { body: 'New.' }));
    });
    land(['t-1']);
    await settle();
    expect(calls.judge).toBe(2);
    // A body edit to the ready task.
    act(() => {
      result.current.noteTask(
        labelled.meta,
        doc('t-1', { body: 'Other.', updated: '2026-01-03' })
      );
    });
    land(['t-1']);
    await waitFor(() => {
      expect(calls.judge).toBe(3);
    });
  });

  test('a ready task that is dispatched costs no judge', async () => {
    const { client, calls } = fakeClient([
      [{ id: 't-1', readiness: reading(3) }],
    ]);
    const { result, rerender } = mount(client, new Set(['t-1']));
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    const ready = doc('t-1');
    act(() => {
      result.current.noteTask(ready.meta, {
        ...ready,
        meta: { ...ready.meta, updated: '2026-01-02' },
      });
    });
    rerender({ ready: new Set() });
    await settle();
    expect(calls.judge).toBe(1);
  });

  test('a task edited while not ready loses its reading and is judged once ready', async () => {
    const { client, calls } = fakeClient(
      [
        [{ id: 't-1', readiness: reading(3) }],
        [
          { id: 't-1', readiness: reading(3) },
          { id: 't-2', readiness: reading(2) },
        ],
      ],
      { 't-1': reading(3), 't-2': reading(0) }
    );
    const { result, rerender } = mount(client, new Set(['t-1']));
    const land = (ready: string[]) => rerender({ ready: new Set(ready) });
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    const draft = doc('t-2');
    act(() => {
      result.current.noteTask(draft.meta, doc('t-2', { body: 'Now clear.' }));
    });
    land(['t-1']);
    await settle();
    expect(calls.judge).toBe(1);

    land(['t-1', 't-2']);
    // Not the stale level 0 while the judge runs.
    expect(result.current.readinessById.get('t-2')).toBeUndefined();
    await waitFor(() => {
      expect(result.current.readinessById.get('t-2')?.level).toBe(2);
    });
    expect(calls.judge).toBe(2);
  });

  test('a task that turns ready without a reading is judged; one with a reading is not', async () => {
    const { client, calls } = fakeClient(
      [[{ id: 't-1', readiness: reading(3) }]],
      { 't-1': reading(3), 't-2': reading(2) }
    );
    const { rerender } = mount(client, new Set(['t-1']));
    await waitFor(() => {
      expect(calls.judge).toBe(1);
    });
    rerender({ ready: new Set(['t-1', 't-2']) });
    await settle();
    expect(calls.judge).toBe(1);
    rerender({ ready: new Set(['t-1', 't-2', 't-3']) });
    await waitFor(() => {
      expect(calls.judge).toBe(2);
    });
  });
});
