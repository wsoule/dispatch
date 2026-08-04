import { describe, expect, it } from 'bun:test';

import { colorForEpic, colorForProject } from './projectColor';

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

describe('colorForEpic', () => {
  it('always returns one of the eight palette tokens', () => {
    for (const id of ['e-359627', 'e-abc', '', 'e-'.repeat(50)]) {
      expect(colorForEpic(id)).toMatch(TOKEN_PATTERN);
    }
  });

  it('is stable across calls, so a swim lane keeps its color', () => {
    expect(colorForEpic('e-359627')).toBe(colorForEpic('e-359627'));
  });

  it('spreads a realistic set of epic ids across more than one color, so lanes are actually distinguishable', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `e-${i}f${i * 7}`);
    const distinct = new Set(ids.map(colorForEpic));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
