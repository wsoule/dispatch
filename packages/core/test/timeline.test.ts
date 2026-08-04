import { describe, expect, it } from 'bun:test';

import { isOutstanding } from '../src/timeline.js';

const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-08-02T00:00:00.000Z';

describe('isOutstanding', () => {
  it('is true when never accounted for', () => {
    expect(isOutstanding(T1, undefined)).toBe(true);
  });

  it('is true when content moved forward', () => {
    expect(isOutstanding(T2, T1)).toBe(true);
  });

  it('is false when content moved backwards', () => {
    expect(isOutstanding(T1, T2)).toBe(false);
  });

  it('is false when content is unchanged', () => {
    expect(isOutstanding(T1, T1)).toBe(false);
  });

  it('is false when either timestamp is unparseable', () => {
    expect(isOutstanding('not-a-date', T1)).toBe(false);
    expect(isOutstanding(T2, 'not-a-date')).toBe(false);
  });
});
