import { describe, expect, test } from 'bun:test';

import {
  estimateLabel,
  estimateOptions,
  type EstimateScale,
  isAllowedEstimate,
  isEstimateScaleType,
} from '../src/index';

const scale = (
  type: EstimateScale['type'],
  options: Partial<Omit<EstimateScale, 'type'>> = {}
): EstimateScale => ({
  type,
  allowZero: options.allowZero ?? false,
  extended: options.extended ?? false,
});

describe('estimate scales (linear.app/docs/estimates)', () => {
  test.each([
    ['exponential', [1, 2, 4, 8, 16], [32, 64]],
    ['fibonacci', [1, 2, 3, 5, 8], [13, 21]],
    ['linear', [1, 2, 3, 4, 5], [6, 7]],
    ['tShirt', [1, 2, 3, 5, 8], [13, 21]],
  ] as const)('%s: base, extended and zero values', (type, base, extra) => {
    expect(estimateOptions(scale(type)).map((o) => o.value)).toEqual([...base]);
    expect(
      estimateOptions(scale(type, { extended: true })).map((o) => o.value)
    ).toEqual([...base, ...extra]);
    expect(
      estimateOptions(scale(type, { allowZero: true })).map((o) => o.value)
    ).toEqual([0, ...base]);
  });

  test('T-shirt sizes read as sizes and are stored as Fibonacci numbers', () => {
    expect(
      estimateOptions(scale('tShirt', { extended: true })).map((o) => o.label)
    ).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
    expect(estimateLabel(scale('tShirt'), 5)).toBe('L');
    // A value off the scale (the team changed scales) still reads.
    expect(estimateLabel(scale('tShirt'), 4)).toBe('4');
    expect(estimateLabel(scale('fibonacci'), 5)).toBe('5');
  });

  test('a team without estimates offers nothing and accepts nothing', () => {
    expect(estimateOptions(scale('notUsed'))).toEqual([]);
    expect(isAllowedEstimate(scale('notUsed'), 1)).toBe(false);
  });

  test('isAllowedEstimate follows the options', () => {
    expect(isAllowedEstimate(scale('fibonacci'), 5)).toBe(true);
    expect(isAllowedEstimate(scale('fibonacci'), 4)).toBe(false);
    expect(isAllowedEstimate(scale('fibonacci'), 13)).toBe(false);
    expect(isAllowedEstimate(scale('fibonacci', { extended: true }), 13)).toBe(
      true
    );
    expect(isAllowedEstimate(scale('linear'), 0)).toBe(false);
    expect(isAllowedEstimate(scale('linear', { allowZero: true }), 0)).toBe(
      true
    );
    expect(isAllowedEstimate(scale('linear'), 2.5)).toBe(false);
  });

  test('isEstimateScaleType knows exactly the five Linear types', () => {
    for (const type of [
      'notUsed',
      'exponential',
      'fibonacci',
      'linear',
      'tShirt',
    ]) {
      expect(isEstimateScaleType(type)).toBe(true);
    }
    expect(isEstimateScaleType('tshirt')).toBe(false);
    expect(isEstimateScaleType('')).toBe(false);
  });
});
