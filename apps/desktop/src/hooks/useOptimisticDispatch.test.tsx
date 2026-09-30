import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { useOptimisticDispatch } from './useOptimisticDispatch';

const NONE = new Set<string>();
const waiting = () => true;

test('a refused dispatch rolls back and reports why', async () => {
  const failures: [string, string][] = [];
  let reject: (err: Error) => void = () => {};
  const { result } = renderHook(() =>
    useOptimisticDispatch(
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
      NONE,
      waiting,
      (taskId, message) => failures.push([taskId, message])
    )
  );
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = result.current.dispatch('t-1');
  });
  // In flight at once, before the daemon answers.
  expect(result.current.pending.get('t-1')?.state).toBe('sending');
  await act(async () => {
    reject(new Error('task is blocked'));
    await done;
  });
  expect(result.current.pending.size).toBe(0);
  expect(failures).toEqual([['t-1', 'task is blocked']]);
});

test('an accepted dispatch stays in flight until its run is live', async () => {
  let live = NONE;
  const { result, rerender } = renderHook(() =>
    useOptimisticDispatch(
      () => Promise.resolve(),
      live,
      waiting,
      () => {}
    )
  );
  await act(async () => {
    await result.current.dispatch('t-1');
  });
  expect(result.current.pending.get('t-1')?.state).toBe('sent');
  live = new Set(['t-1']);
  act(() => rerender());
  expect(result.current.pending.size).toBe(0);
});
