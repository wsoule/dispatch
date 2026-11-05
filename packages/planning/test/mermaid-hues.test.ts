import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MERMAID_HUES } from '../src/index';

// The Mermaid export cannot read CSS variables, so MERMAID_HUES holds its
// own status hexes (architecture §2.10 "Mermaid", §8.2 "Status colours").
// They are the ui's status hues (the same hue as tokens.css's --red,
// --amber and --green, read from that file) at a mid tone: the app's light
// hues are deep text-safe steps (the Gr8r tokens, owner decision
// 2026-10-23) that would fall under 3:1 on a dark page, and pasted Mermaid
// renders in either theme. The test also checks the 3:1 the export's doc
// promises for a stroke on the backgrounds pasted Mermaid usually lands
// on. planning:test lists tokens.css as an input (moon.yml), so a token
// change reruns it.

const TOKENS = path.join(
  import.meta.dir,
  '..',
  '..',
  'ui',
  'src',
  'styles',
  'tokens.css'
);

/**
 * The light token block of tokens.css: from its selector to the first
 * closing brace at the start of a line (the block holds no nested rule).
 */
function lightBlock(css: string): string {
  const selector = ':root:where(:not([data-bt-ui-scoped])),\n[data-bt-ui] {';
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** A custom property's hex in a block (`--red: #d92d20;`), or null. */
function hexOf(block: string, name: string): string | null {
  const match = new RegExp(
    `^\\s*--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`,
    'm'
  ).exec(block);
  return match?.[1]?.toLowerCase() ?? null;
}

/** The HSL hue angle (0–360) of a #rrggbb colour. */
function hueAngle(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  ) as [number, number, number];
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return 0;
  const sector =
    max === r
      ? ((g - b) / span) % 6
      : max === g
        ? (b - r) / span + 2
        : (r - g) / span + 4;
  return (sector * 60 + 360) % 360;
}

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('MERMAID_HUES', () => {
  const block = lightBlock(readFileSync(TOKENS, 'utf8'));

  test.each(['red', 'amber', 'green'] as const)(
    '%s is the same hue as the light theme token of tokens.css',
    (hue) => {
      const token = hexOf(block, hue);
      expect({ hue, token }).toEqual({
        hue,
        token: expect.stringMatching(/^#[0-9a-f]{6}$/),
      });
      const apart = Math.abs(
        hueAngle(MERMAID_HUES[hue]) - hueAngle(token ?? '')
      );
      expect(Math.min(apart, 360 - apart)).toBeLessThanOrEqual(12);
    }
  );

  // White and GitHub's dark page (#0d1117) behind an edge; Mermaid's
  // default node fills (light #ececff, dark #1f2020) inside a node.
  test.each([
    ['white', '#ffffff'],
    ['the light node fill', '#ececff'],
    ['the dark node fill', '#1f2020'],
    ["GitHub's dark page", '#0d1117'],
  ])('every hue holds 3:1 as a stroke on %s', (_name, ground) => {
    for (const hex of Object.values(MERMAID_HUES)) {
      expect(contrast(hex, ground)).toBeGreaterThanOrEqual(3);
    }
  });
});
