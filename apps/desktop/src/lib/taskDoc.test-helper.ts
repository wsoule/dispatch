// A full TaskDoc for tests that care about a few of its fields.
import type { TaskDoc, TaskMeta } from '@dispatch/core/browser';
import { defaultTaskFields } from '@dispatch/core/browser';

export function taskDoc(
  meta: Pick<TaskMeta, 'id' | 'title'> & Partial<TaskMeta>,
  body = ''
): TaskDoc {
  return {
    meta: {
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'agent',
      created: '2026-09-25T10:00:00.000Z',
      updated: '2026-09-25T10:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...defaultTaskFields(),
      ...meta,
    },
    body,
  };
}
