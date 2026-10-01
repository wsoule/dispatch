import { describe, expect, it } from 'bun:test';

import { createUlidFactory } from '../src/ulid.js';

const zeros = (n: number) => new Uint8Array(n);

describe('createUlidFactory', () => {
  it('encodes time in the first 10 chars', () => {
    const next = createUlidFactory(zeros);
    expect(next(0)).toBe('00000000000000000000000000');
    expect(next(1)).toBe('00000000010000000000000000');
    expect(next(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
  });

  it('is monotonic within one millisecond', () => {
    const next = createUlidFactory(zeros);
    const a = next(1000);
    const b = next(1000);
    const c = next(1000);
    expect(a < b && b < c).toBe(true);
    expect(c.slice(10)).toBe('0000000000000002');
  });

  it('stays monotonic when the clock goes backwards', () => {
    const next = createUlidFactory(zeros);
    const a = next(5000);
    const b = next(4000);
    expect(b > a).toBe(true);
    expect(b.slice(0, 10)).toBe(a.slice(0, 10));
  });

  it('sorts across milliseconds and lowercases without reordering', () => {
    const next = createUlidFactory();
    const ids = [next(10), next(11), next(12)];
    expect([...ids].sort()).toEqual(ids);
    const lower = ids.map((id) => id.toLowerCase());
    expect([...lower].sort()).toEqual(lower);
  });

  it('rejects out-of-range times', () => {
    const next = createUlidFactory();
    expect(() => next(-1)).toThrow(RangeError);
    expect(() => next(2 ** 48)).toThrow(RangeError);
  });
});
