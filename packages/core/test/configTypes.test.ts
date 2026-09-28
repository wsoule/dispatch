import { describe, expect, it } from 'bun:test';

import { notificationKindForMessage } from '../src/configTypes.js';

const q = (data?: unknown) => ({ kind: 'question', blocking: true, data });

describe('notificationKindForMessage', () => {
  it('maps gates onto the notification toggles', () => {
    expect(notificationKindForMessage(q({ type: 'tool-approval' }))).toBe(
      'approval'
    );
    expect(notificationKindForMessage(q({ type: 'wake' }))).toBe('approval');
    expect(notificationKindForMessage(q({ type: 'agent-registration' }))).toBe(
      'approval'
    );
    expect(notificationKindForMessage(q({ type: 'overseer-action' }))).toBe(
      'approval'
    );
    expect(notificationKindForMessage(q({ type: 'scope' }))).toBe(
      'scope-request'
    );
    expect(notificationKindForMessage(q())).toBe('question');
    expect(notificationKindForMessage(q({ type: 'x-poll' }))).toBe('question');
  });

  it('notifies a task proposal under approval', () => {
    expect(notificationKindForMessage(q({ type: 'task-proposal' }))).toBe(
      'approval'
    );
  });

  it('is null for anything that is not a blocking question', () => {
    expect(
      notificationKindForMessage({ kind: 'question', blocking: false })
    ).toBeNull();
    expect(
      notificationKindForMessage({ kind: 'notice', blocking: false })
    ).toBeNull();
    expect(
      notificationKindForMessage({ kind: 'handoff', blocking: true })
    ).toBeNull();
  });
});
