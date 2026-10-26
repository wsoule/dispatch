import { describe, expect, test } from 'bun:test';

import { formatElapsed } from './use-elapsed';

describe('formatElapsed', () => {
  test('formats seconds under a minute as m:ss', () => {
    expect(formatElapsed(7_000)).toBe('0:07');
  });

  test('formats minutes and seconds as m:ss', () => {
    expect(formatElapsed(61_000)).toBe('1:01');
  });

  test('formats an hour or more as h:mm:ss', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});
