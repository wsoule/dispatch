import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FENCE_THEMES, toFenceTokens } from './highlight';

// The fence colours come from Shiki's GitHub high-contrast themes (main v0.51.0 brought
// Shiki to Markdown fences with GitHub light and dark; the Gr8r rule is 4.5:1 for text).

/** A #rgb or #rrggbb colour's relative luminance (WCAG 2). */
function luminance(colour: string): number {
  const digits = colour.replace('#', '');
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits;
  const [r, g, b] = [0, 2, 4].map((at) => {
    const value = Number.parseInt(full.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** A token's value in tokens.css: the first declaration is the light theme's, the second
    the dark theme's (the third repeats it for data-theme="system"). */
function tokenValues(name: string): { light: string; dark: string } {
  const tokens = readFileSync(
    path.join(
      path.dirname(Bun.resolveSync('@dispatch/ui/styles.css', import.meta.dir)),
      'tokens.css'
    ),
    'utf8'
  );
  const values = [
    ...tokens.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{3,6})\\b`, 'gi')),
  ].map((match) => match[1] ?? '');
  const [light, dark] = values;
  if (light === undefined || dark === undefined)
    throw new Error(`${name} has no light and dark values`);
  return { light, dark };
}

describe('toFenceTokens', () => {
  test('keeps each run’s two colour variables and drops the theme default', () => {
    // Colour words stand in for Shiki's hex values; the default compares case-blind.
    const lines = toFenceTokens(
      [
        [
          {
            content: 'const',
            htmlStyle: {
              '--shiki-light': 'Crimson',
              '--shiki-dark': 'Salmon',
              '--shiki-light-font-style': 'italic',
            },
          },
          {
            content: ' x',
            htmlStyle: { '--shiki-light': 'NAVY', '--shiki-dark': 'Ivory' },
          },
        ],
        [],
        [
          { content: 'y' },
          {
            content: 'z',
            htmlStyle: { '--shiki-light': 'Teal', '--shiki-dark': 'inherit' },
          },
          {
            content: '^M',
            htmlStyle: {
              '--shiki-light': 'White',
              '--shiki-light-bg': 'Crimson',
              '--shiki-dark': 'White',
              '--shiki-dark-bg': 'Salmon',
            },
          },
        ],
      ],
      '--shiki-light:navy;--shiki-dark:ivory'
    );
    expect(lines).toEqual([
      [
        {
          content: 'const',
          vars: { '--shiki-light': 'Crimson', '--shiki-dark': 'Salmon' },
        },
        { content: ' x' },
      ],
      [],
      [
        { content: 'y' },
        { content: 'z', vars: { '--shiki-light': 'Teal' } },
        { content: '^M' },
      ],
    ]);
  });
});

describe('the fence themes', () => {
  test('every token colour holds 4.5:1 on the fence well and the surfaces, in its theme', async () => {
    const { createHighlighter } = await import('shiki');
    const highlighter = await createHighlighter({
      themes: [FENCE_THEMES.light, FENCE_THEMES.dark],
      langs: [],
    });
    const grounds = ['--sunken', '--surface', '--surface-2'].map(tokenValues);
    const failing: string[] = [];
    for (const mode of ['light', 'dark'] as const) {
      const theme = highlighter.getTheme(FENCE_THEMES[mode]);
      const colours = new Set<string>([theme.fg.toLowerCase()]);
      for (const rule of theme.settings ?? []) {
        const colour = rule.settings?.foreground?.toLowerCase();
        // A rule with a fill of its own draws plain (toFenceTokens drops its colour).
        if (rule.settings?.background !== undefined) continue;
        // Opaque colours only: a translucent one (#rrggbbaa) is a highlight, not ink.
        if (
          colour !== undefined &&
          /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(colour)
        )
          colours.add(colour);
      }
      for (const colour of colours) {
        for (const ground of grounds) {
          const ratio = contrast(colour, ground[mode]);
          if (ratio < 4.5)
            failing.push(
              `${mode} ${colour} on ${ground[mode]}: ${ratio.toFixed(2)}`
            );
        }
      }
    }
    highlighter.dispose();
    expect(failing).toEqual([]);
  });
});
