import { describe, expect, test } from 'bun:test';

import { connectionIndicator } from './ConnectionIndicator';

const NOW = 1_000_000;

describe('connectionIndicator', () => {
  test('a healthy local daemon says nothing', () => {
    expect(
      connectionIndicator({ state: 'open', failures: 0, retryAt: null }, null)
    ).toBeNull();
    expect(
      connectionIndicator(
        { state: 'connecting', failures: 0, retryAt: null },
        null
      )
    ).toBeNull();
  });

  test('a remote daemon always shows where it is', () => {
    expect(
      connectionIndicator(
        { state: 'open', failures: 0, retryAt: null },
        'https://devbox.example.com:4771'
      )?.label
    ).toBe('devbox.example.com:4771');
  });

  test('a drop reads as reconnecting, then offline after three failures', () => {
    const first = connectionIndicator(
      { state: 'reconnecting', failures: 1, retryAt: NOW + 2000 },
      null,
      NOW
    );
    expect(first?.label).toBe('Reconnecting…');
    expect(first?.detail).toContain('Retrying in 2s');
    expect(
      connectionIndicator(
        { state: 'reconnecting', failures: 3, retryAt: NOW + 15_000 },
        'https://devbox:4771',
        NOW
      )
    ).toMatchObject({ label: 'Offline' });
  });
});
