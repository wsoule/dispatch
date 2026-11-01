import { describe, expect, it } from 'bun:test';

import {
  clampConcurrencyInput,
  concurrencyChoices,
  concurrencyLabel,
} from './milestoneConcurrency.js';

describe('clampConcurrencyInput', () => {
  it('rounds a fractional value to the nearest integer', () => {
    expect(clampConcurrencyInput('2.5')).toBe(3);
    expect(clampConcurrencyInput('2.4')).toBe(2);
  });

  it('floors below 1 back up to 1', () => {
    expect(clampConcurrencyInput('0')).toBe(1);
    expect(clampConcurrencyInput('-3')).toBe(1);
    expect(clampConcurrencyInput('0.4')).toBe(1);
  });

  it('falls back to 1 for empty or non-numeric input', () => {
    expect(clampConcurrencyInput('')).toBe(1);
    expect(clampConcurrencyInput('abc')).toBe(1);
  });

  it('passes through a valid integer unchanged', () => {
    expect(clampConcurrencyInput('4')).toBe(4);
  });
});

describe('concurrencyChoices', () => {
  it('offers 1 through 4 for the usual defaults', () => {
    expect(concurrencyChoices(3)).toEqual([1, 2, 3, 4]);
    expect(concurrencyChoices(1)).toEqual([1, 2, 3, 4]);
  });

  it('extends to a larger configured default so it stays selectable', () => {
    expect(concurrencyChoices(6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('offers up to a caller-supplied max', () => {
    expect(concurrencyChoices(3, 16)).toHaveLength(16);
    expect(concurrencyChoices(3, 16).at(-1)).toBe(16);
    expect(concurrencyChoices(3, 2)).toEqual([1, 2, 3]);
  });

  it('a nonsensical max still offers at least the default', () => {
    expect(concurrencyChoices(3, 0)).toEqual([1, 2, 3]);
    expect(concurrencyChoices(2, Number.NaN)).toEqual([1, 2]);
  });

  it('labels a choice as N×', () => {
    expect(concurrencyLabel(2)).toBe('2×');
  });
});
