import { describe, expect, it } from 'bun:test';

import { clampConcurrencyInput } from './epicConcurrency.js';

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
