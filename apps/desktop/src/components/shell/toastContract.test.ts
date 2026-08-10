import { describe, expect, test } from 'bun:test';

import { sonnerOptionsFor } from './toastContract';

describe('sonnerOptionsFor', () => {
  test('errors never auto-dismiss', () => {
    expect(sonnerOptionsFor('error').duration).toBe(Infinity);
  });
  test('success and info keep their current timings', () => {
    expect(sonnerOptionsFor('success').duration).toBe(3500);
    expect(sonnerOptionsFor('info').duration).toBe(4500);
  });
});
