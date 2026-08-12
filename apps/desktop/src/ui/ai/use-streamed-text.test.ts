import { describe, expect, test } from 'bun:test';

import { nextSlice } from './use-streamed-text';

describe('nextSlice', () => {
  test('extends a mid-word tick forward to the next whitespace boundary', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, '', 5)).toBe('The quick');
  });

  test('keeps extending across ticks, never splitting a word', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, 'The quick', 5)).toBe('The quick brown');
  });

  test('reveals the remainder in one tick once the tail fits within the step', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, 'The quick brown', 5)).toBe(full);
  });

  test('revealing an already-complete string returns full unchanged', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, full, 5)).toBe(full);
  });

  test('a single long word with no whitespace reveals in full rather than splitting', () => {
    const full = 'Supercalifragilisticexpialidocious';
    expect(nextSlice(full, '', 3)).toBe(full);
  });

  test('charsPerTick of zero or negative still makes progress (min 1)', () => {
    const full = 'ab cd';
    expect(nextSlice(full, '', 0)).toBe('ab');
    expect(nextSlice(full, '', -3)).toBe('ab');
  });

  test('a tick landing exactly on a whitespace boundary stops before the space', () => {
    const full = 'Hi there';
    expect(nextSlice(full, '', 2)).toBe('Hi');
  });
});
