import { describe, expect, it } from 'bun:test';

import type { TaskDraft } from '../src/api';
import { httpToWs, taskDraftToCreateInput, taskQueryString } from '../src/api';

describe('httpToWs', () => {
  it('swaps http for ws and appends /ws', () => {
    expect(httpToWs('http://127.0.0.1:4771')).toBe('ws://127.0.0.1:4771/ws');
  });

  it('swaps https for wss and appends /ws', () => {
    expect(httpToWs('https://dispatch.example')).toBe(
      'wss://dispatch.example/ws'
    );
  });
});

describe('taskQueryString', () => {
  it('returns an empty string with no filter', () => {
    expect(taskQueryString()).toBe('');
    expect(taskQueryString({})).toBe('');
  });

  it('encodes a single filter field', () => {
    expect(taskQueryString({ status: 'todo' })).toBe('?status=todo');
  });

  it('encodes multiple filter fields in status/kind/parent order', () => {
    expect(
      taskQueryString({ status: 'todo', kind: 'task', parent: 'epic-1' })
    ).toBe('?status=todo&kind=task&parent=epic-1');
  });

  it('emits archived=1 only when archived is true', () => {
    expect(taskQueryString({ archived: true })).toBe('?archived=1');
    expect(taskQueryString({ archived: false })).toBe('');
  });
});

describe('taskDraftToCreateInput', () => {
  it('folds acceptanceCriteria into the description (createTask ignores a separate field)', () => {
    const draft: TaskDraft = {
      title: 'Add a logout button',
      description: 'Let signed-in users end their session.',
      acceptanceCriteria: [
        'Button visible in the header',
        'Click clears the session',
      ],
      priority: 'high',
    };
    expect(taskDraftToCreateInput(draft)).toEqual({
      title: 'Add a logout button',
      kind: 'task',
      priority: 'high',
      description:
        'Let signed-in users end their session.\n\n' +
        'Acceptance criteria:\n\n' +
        '- Button visible in the header\n- Click clears the session',
    });
  });

  it('emits a bare description when the draft has no acceptanceCriteria', () => {
    const draft: TaskDraft = {
      title: 'Tiny tweak',
      description: 'Just do the thing.',
      acceptanceCriteria: [],
      priority: 'none',
    };
    expect(taskDraftToCreateInput(draft)).toEqual({
      title: 'Tiny tweak',
      kind: 'task',
      priority: 'none',
      description: 'Just do the thing.',
    });
  });
});
