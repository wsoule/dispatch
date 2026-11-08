import type { TaskDoc, TaskListItem } from '@dispatch-foo/core/browser';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { taskDoc } from '../lib/taskDoc.test-helper';
import { type BodyClient, useMilestoneBodies } from './useMilestoneBodies';

// The bodies of milestone tasks, fetched beside the body-less list: only
// milestones, once per `updated` stamp.

function listed(
  id: string,
  kind: 'milestone' | 'task',
  updated = '2026-10-01T00:00:00.000Z'
): TaskListItem {
  return { meta: taskDoc({ id, title: id, kind, updated }).meta };
}

function client(): BodyClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchTask: (id: string) => {
      asked.push(id);
      return Promise.resolve({
        ...taskDoc({ id, title: id }),
        body: `body of ${id} #${asked.length}`,
      } as TaskDoc);
    },
  };
}

describe('useMilestoneBodies', () => {
  test('fetches milestone bodies only', async () => {
    const api = client();
    const tasks = [listed('ms-1', 'milestone'), listed('t-1', 'task')];
    const { result } = renderHook(() => useMilestoneBodies(api, tasks));
    await waitFor(() => expect(result.current.get('ms-1')).toBeDefined());
    expect(api.asked).toEqual(['ms-1']);
    expect(result.current.has('t-1')).toBe(false);
  });

  test('refetches a milestone when it is updated, and only then', async () => {
    const api = client();
    let tasks = [listed('ms-1', 'milestone')];
    const { result, rerender } = renderHook(() =>
      useMilestoneBodies(api, tasks)
    );
    await waitFor(() =>
      expect(result.current.get('ms-1')).toBe('body of ms-1 #1')
    );
    tasks = [listed('ms-1', 'milestone')];
    rerender();
    expect(api.asked).toEqual(['ms-1']);
    tasks = [listed('ms-1', 'milestone', '2026-10-02T00:00:00.000Z')];
    rerender();
    await waitFor(() =>
      expect(result.current.get('ms-1')).toBe('body of ms-1 #2')
    );
  });

  test('fetches nothing without a client', () => {
    const { result } = renderHook(() =>
      useMilestoneBodies(null, [listed('ms-1', 'milestone')])
    );
    expect(result.current.size).toBe(0);
  });
});
