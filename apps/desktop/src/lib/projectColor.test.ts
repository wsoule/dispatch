import { describe, expect, it } from 'bun:test';

import { colorForMilestone, colorForProject } from './projectColor';

const TOKEN_PATTERN = /^var\(--project-color-[1-8]\)$/;

describe('colorForProject', () => {
  it('always returns one of the eight palette tokens', () => {
    for (const id of ['storefront', 'dispatch', '', 'a', 'x'.repeat(200)]) {
      expect(colorForProject(id)).toMatch(TOKEN_PATTERN);
    }
  });

  it('is stable across calls, so a project keeps its color across restarts', () => {
    expect(colorForProject('storefront')).toBe(colorForProject('storefront'));
  });
});

describe('colorForMilestone', () => {
  it('always returns one of the eight palette tokens', () => {
    for (const id of ['e-359627', 'e-abc', '', 'e-'.repeat(50)]) {
      expect(colorForMilestone(id)).toMatch(TOKEN_PATTERN);
    }
  });

  it('is stable across calls, so a swim lane keeps its color', () => {
    expect(colorForMilestone('e-359627')).toBe(colorForMilestone('e-359627'));
  });

  it('spreads a realistic set of milestone ids across more than one color, so lanes are actually distinguishable', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `e-${i}f${i * 7}`);
    const distinct = new Set(ids.map(colorForMilestone));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
