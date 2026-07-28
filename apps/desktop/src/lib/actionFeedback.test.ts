import { describe, expect, test } from 'bun:test';

import {
  describeAction,
  describeError,
  withActionFeedback,
} from './actionFeedback';

describe('describeAction', () => {
  test('turns a handler name into a readable action', () => {
    expect(describeAction('handleArchiveRun')).toBe('Archive run');
    expect(describeAction('handleSubmitReview')).toBe('Submit review');
    expect(describeAction('handleOpenPr')).toBe('Open pr');
  });
});

describe('describeError', () => {
  test('prefers the thrown message', () => {
    expect(describeError(new Error('worktree is dirty'))).toBe(
      'worktree is dirty'
    );
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ weird: true })).toBe('Unknown error');
    // Cross-realm errors (iframe, worker, a second copy of a library) fail
    // `instanceof Error` while carrying a perfectly good message.
    expect(describeError({ message: 'from another realm' })).toBe(
      'from another realm'
    );
    expect(describeError({ message: '' })).toBe('Unknown error');
  });
});

describe('withActionFeedback', () => {
  test('reports a rejected handler instead of leaving it unhandled', async () => {
    const reported: string[] = [];
    const api = withActionFeedback(
      {
        handleArchiveRun: () => Promise.reject(new Error('daemon is down')),
      },
      (action, message) => reported.push(`${action}: ${message}`)
    );

    // The call sites do `void data.handleX()`, so this must resolve rather than
    // reject — otherwise the report happens AND an unhandled rejection fires.
    await api.handleArchiveRun();
    expect(reported).toEqual(['Archive run: daemon is down']);
  });

  test('reports a handler that throws synchronously', () => {
    const reported: string[] = [];
    const api = withActionFeedback(
      {
        handleDispatch: () => {
          throw new Error('no executor');
        },
      },
      (action, message) => reported.push(`${action}: ${message}`)
    );
    expect(() => api.handleDispatch()).not.toThrow();
    expect(reported).toEqual(['Dispatch: no executor']);
  });

  test('passes arguments and resolves values through untouched', async () => {
    const api = withActionFeedback(
      {
        handleUpdate: (id: string, n: number) => Promise.resolve(`${id}:${n}`),
      },
      () => {
        throw new Error('should not be called');
      }
    );
    expect(await api.handleUpdate('t-1', 2)).toBe('t-1:2');
  });

  test('leaves non-handler keys alone', () => {
    const runs = [{ id: 'r-1' }];
    const api = withActionFeedback(
      { runs, setShowArchived: () => {} },
      () => {}
    );
    // Same reference: wrapping data would defeat the memoisation around it.
    expect(api.runs).toBe(runs);
  });
});

describe('success feedback', () => {
  test('confirms only the handlers on the list', async () => {
    const said: string[] = [];
    const api = withActionFeedback(
      {
        handleArchiveRun: () => Promise.resolve('ok'),
        // Not on the list: moving a card confirms itself on screen, and a
        // toast for it would train you to ignore the ones that matter.
        handleUpdate: () => Promise.resolve('ok'),
      },
      () => {},
      (message) => said.push(message)
    );
    await api.handleArchiveRun();
    await api.handleUpdate();
    expect(said).toEqual(['Run archived']);
  });

  test('a failed action is not also reported as a success', async () => {
    const said: string[] = [];
    const failed: string[] = [];
    const api = withActionFeedback(
      { handleArchiveRun: () => Promise.reject(new Error('nope')) },
      (_action, message) => failed.push(message),
      (message) => said.push(message)
    );
    await api.handleArchiveRun();
    expect(said).toEqual([]);
    expect(failed).toEqual(['nope']);
  });
});
