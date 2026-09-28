import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_NOTIFICATIONS,
  NOTIFICATION_KINDS,
  notificationKindForMessage,
} from '../src/configTypes.js';

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

  it('notifies memory gates under their own toggle', () => {
    expect(
      notificationKindForMessage(
        q({
          type: 'memory',
          proposalId: 'mp-1',
          action: 'add',
          scope: 'team',
          kind: 'hazard',
        })
      )
    ).toBe('memory');
    expect(DEFAULT_NOTIFICATIONS.kinds.memory).toBe(true);
    expect(NOTIFICATION_KINDS).toEqual([
      'question',
      'approval',
      'scope-request',
      'memory',
      'fix-loop-capped',
      'run-stalled',
    ]);
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
