import type { StatusModel } from '@dispatch-foo/core/browser';
import { statusModelOf } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import { BLOCKED_TONE, statusTone } from './statusTone';

// A Linear team's workflow mirrored into config, with a configured colour on
// two states: none of these names is a built-in, so each reads by its type.
const LINEAR: StatusModel = statusModelOf({
  statusDefinitions: [
    { name: 'Triage', type: 'triage', color: null },
    { name: 'Backlog', type: 'backlog', color: null },
    { name: 'Todo', type: 'unstarted', color: null },
    { name: 'In Progress', type: 'started', color: '#f2c94c' },
    { name: 'Done', type: 'completed', color: '#5e6ad2' },
    { name: 'Canceled', type: 'canceled', color: null },
  ],
  statusRoles: {
    ready: 'Todo',
    dispatched: 'In Progress',
    review: null,
    landing: null,
    landed: 'Done',
    dropped: 'Canceled',
  },
});

describe('statusTone', () => {
  test.each([
    ['draft', 'muted'],
    ['ready', 'muted'],
    ['working', 'info'],
    ['landing', 'info'],
    ['review', 'success'],
    ['dropped', 'muted'],
  ] as const)('built-in %s is %s', (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });

  test('landed is the filled neutral mark: no tone, never green', () => {
    expect(statusTone('landed')).toBeNull();
  });

  test.each([
    ['Triage', 'muted'],
    ['Backlog', 'muted'],
    ['Todo', 'muted'],
    ['In Progress', 'info'],
    ['Canceled', 'muted'],
  ] as const)(
    'a typed custom status %s reads by its type: %s',
    (status, tone) => {
      expect(statusTone(status, LINEAR)).toBe(tone);
    }
  );

  test('a completed custom status is neutral; a configured colour is not painted', () => {
    expect(statusTone('Done', LINEAR)).toBeNull();
    // In Progress is configured yellow in Linear; the hue table keeps it blue.
    expect(statusTone('In Progress', LINEAR)).toBe('info');
  });

  test('an untyped custom status is muted like todo', () => {
    expect(statusTone('triage')).toBe('muted');
    expect(statusTone('someday')).toBe('muted');
  });

  test('a prototype key is not a built-in status', () => {
    expect(statusTone('constructor')).toBe('muted');
  });

  test('blocked is amber', () => {
    expect(BLOCKED_TONE).toBe('warning');
  });
});
