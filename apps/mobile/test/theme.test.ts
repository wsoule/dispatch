import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { generateTheme, OUTPUT_PATH, TOKENS_PATH } from '../scripts/theme';

describe('the phone theme', () => {
  test('matches the desktop tokens (run `moon run mobile:theme` if not)', () => {
    const expected = generateTheme(readFileSync(TOKENS_PATH, 'utf8'));
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(expected);
  });

  test('resolves var() chains and color-mix() tints to literals', () => {
    const css = `:root:where(:not([data-bt-ui-scoped])) {
      --bg: #fff; --bg-side: #fff; --surface: #fff; --surface-2: #fff;
      --surface-3: #fff; --sunken: var(--bg); --overlay: rgba(0, 0, 0, 0.5);
      --border: #eee; --border-strong: #ddd; --divider: #eee;
      --control-border: #888; --text: #111; --text-2: #222; --text-3: #333;
      --text-4: #444; --text-inv: #fff; --accent: #9747ff; --on-accent: #fff;
      --accent-ink: #7c33ea;
      --accent-soft: color-mix(in srgb, var(--accent) 10%, transparent);
      --accent-line: color-mix(in srgb, var(--accent) 50%, #ffffff);
      --red: #ff0000; --amber: #880000; --green: #008800; --blue: #000088;
      --gray: #888;
      --red-soft: color-mix(in srgb, var(--red) 10%, transparent);
      --amber-soft: var(--red-soft); --green-soft: var(--red-soft);
      --blue-soft: var(--red-soft); --red-line: var(--red-soft);
      --amber-line: var(--red-soft); --green-line: var(--red-soft);
      --blue-line: var(--red-soft); --on-red: #fff;
      --r-xs: 4px; --r-chip: 5px; --r-sm: 6px; --r: 8px; --r-lg: 10px;
      --r-xl: 12px;
    }
    html[data-theme='dark'] { --red: #00ff00; }`;
    const out = generateTheme(css);
    const darkPart = out.slice(out.indexOf('export const dark'));
    expect(out).toContain("sunken: '#fff'");
    expect(out).toContain("accentSoft: 'rgba(151, 71, 255, 0.1)'");
    expect(out).toContain("accentLine: '#cba3ff'");
    // Dark's tint follows dark's hue, not light's.
    expect(darkPart).toContain("redSoft: 'rgba(0, 255, 0, 0.1)'");
    expect(out).toContain('md: 8,');
  });
});
