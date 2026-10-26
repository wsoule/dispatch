// Linear's estimate scales (linear.app/docs/estimates), so the issue page
// offers only values the issue's team accepts and the engine can refuse an
// invalid estimate before Linear does. T-shirt sizes are stored as the
// Fibonacci numbers they translate to (XS 1 … XL 8, extended XXL 13 and
// XXXL 21), which is what Linear's API reads and writes.

import type { EstimateOption, EstimateScale, EstimateScaleType } from './types';

/** Every value of each scale: the base values, then the extended ones. */
const SCALE_VALUES: Record<
  Exclude<EstimateScaleType, 'notUsed'>,
  { base: readonly number[]; extended: readonly number[] }
> = {
  exponential: { base: [1, 2, 4, 8, 16], extended: [32, 64] },
  fibonacci: { base: [1, 2, 3, 5, 8], extended: [13, 21] },
  linear: { base: [1, 2, 3, 4, 5], extended: [6, 7] },
  tShirt: { base: [1, 2, 3, 5, 8], extended: [13, 21] },
};

/** T-shirt size names by stored value. */
const T_SHIRT_LABEL: ReadonlyMap<number, string> = new Map([
  [1, 'XS'],
  [2, 'S'],
  [3, 'M'],
  [5, 'L'],
  [8, 'XL'],
  [13, 'XXL'],
  [21, 'XXXL'],
]);

const SCALE_TYPES: ReadonlySet<string> = new Set<EstimateScaleType>([
  'notUsed',
  'exponential',
  'fibonacci',
  'linear',
  'tShirt',
]);

/** True for a scale type the planner knows (Linear sends a free string). */
export function isEstimateScaleType(value: string): value is EstimateScaleType {
  return SCALE_TYPES.has(value);
}

/** How a stored estimate reads on `scale` ("5", or "L" for T-shirt sizes). */
export function estimateLabel(scale: EstimateScale, value: number): string {
  if (scale.type === 'tShirt') {
    return T_SHIRT_LABEL.get(value) ?? String(value);
  }
  return String(value);
}

/**
 * The estimates the team accepts, smallest first: 0 when zero estimates are
 * allowed, the base values, then the extended ones. Empty for `notUsed`
 * (only "no estimate" is valid then).
 */
export function estimateOptions(scale: EstimateScale): EstimateOption[] {
  if (scale.type === 'notUsed') return [];
  const values = SCALE_VALUES[scale.type];
  const all = [
    ...(scale.allowZero ? [0] : []),
    ...values.base,
    ...(scale.extended ? values.extended : []),
  ];
  return all.map((value) => ({ value, label: estimateLabel(scale, value) }));
}

/** True when `value` is one of estimateOptions(scale). */
export function isAllowedEstimate(
  scale: EstimateScale,
  value: number
): boolean {
  return estimateOptions(scale).some((option) => option.value === value);
}
