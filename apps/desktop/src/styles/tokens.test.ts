import { expect, test } from 'bun:test';

const tailwind = await Bun.file(
  new URL('./tailwind.css', import.meta.url)
).text();
const tokens = await Bun.file(new URL('./tokens.css', import.meta.url)).text();

// tailwind.css must only alias tokens.css — never restate the palette.
test('tailwind.css declares no hex literals', () => {
  const hexes = tailwind.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  expect(hexes).toEqual([]);
});

// The reskin's keystone: the accent is Beautiful UI blue in both themes.
test('--accent is Beautiful UI blue', () => {
  expect(tokens).toContain('--accent: #0285ff');
  expect(tokens).toContain('--accent: #3d9aff');
});

// New concepts the reskin introduces must exist in both theme blocks where
// they carry per-theme values.
const perTheme = [
  '--surface-hover:',
  '--surface-inset:',
  '--field:',
  '--accent-tint:',
  '--tooltip-bg:',
  '--shadow-btn:',
  '--shadow-card:',
  '--shadow-overlay:',
];
test('reskin tokens exist in light and dark blocks', () => {
  for (const t of perTheme) {
    const count = tokens.split(t).length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  }
});

// Radii and easing are theme-invariant — exactly one declaration each.
test('structural tokens declared once', () => {
  for (const t of [
    '--radius-chip:',
    '--radius-control:',
    '--radius-card:',
    '--ease-out-expo:',
  ]) {
    expect(tokens.split(t).length - 1).toBe(1);
  }
});
