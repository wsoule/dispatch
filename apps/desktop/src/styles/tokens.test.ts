import { expect, test } from 'bun:test';

const tailwind = await Bun.file(
  new URL('./tailwind.css', import.meta.url)
).text();
const tokens = await Bun.file(
  Bun.resolveSync('@dispatch/tokens/tokens.css', import.meta.dir)
).text();

// tokens.css is one light `:root` block followed by one dark media block; the
// site's theme splitter (apps/site/src/lib/themeTokens.ts) relies on exactly
// that shape.
const [light, dark, ...rest] = tokens.split(
  '@media (prefers-color-scheme: dark)'
);
if (light === undefined || dark === undefined) {
  throw new Error('tokens.css has no dark block');
}

function declares(block: string, token: string): boolean {
  return block.includes(`${token}:`);
}

test('tokens.css has exactly one dark block', () => {
  expect(rest).toEqual([]);
  expect(declares(light, '--surface-page')).toBe(true);
  expect(declares(dark, '--surface-page')).toBe(true);
});

// tailwind.css must only alias tokens.css — never restate the palette.
test('tailwind.css declares no hex literals', () => {
  const hexes = tailwind.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  expect(hexes).toEqual([]);
});

// The keystone: the accent is Linear indigo in both themes, and the focus ring
// is its measured sibling.
test('accent and focus ring are Linear indigo in both blocks', () => {
  for (const block of [light, dark]) {
    expect(block).toContain('--accent: #5e6ad2;');
    expect(block).toContain('--border-selected: #5e6ad2;');
    expect(block).toContain('--focus-ring: #5e69d1;');
  }
});

// T3 Code's dark: a true-black canvas whose edges are white alpha hairlines.
test('dark surfaces, text and borders are the T3 Code values', () => {
  for (const decl of [
    '--surface-frame: #000000;',
    '--surface-panel: #050505;',
    '--surface-quaternary: #111111;',
    '--surface-popover: #141414;',
    '--text-primary: #f5f5f5;',
    '--text-muted: #a3a3a3;',
    '--border-subtle: rgb(255 255 255 / 0.05);',
    '--border-default: rgb(255 255 255 / 0.08);',
    '--border-strong: rgb(255 255 255 / 0.11);',
    '--border-popover: rgb(255 255 255 / 0.1);',
  ]) {
    expect(dark).toContain(decl);
  }
  expect(light).toContain('--surface-frame: #f4f4f5;');
  expect(light).toContain('--surface-panel: #fdfdfd;');
  expect(light).toContain('--text-primary: #18181b;');
});

// Every token that carries a per-theme value must exist in both blocks.
const perTheme = [
  '--surface-frame',
  '--surface-panel',
  '--surface-secondary',
  '--surface-tertiary',
  '--surface-quaternary',
  '--surface-popover',
  '--surface-control',
  '--surface-selected',
  '--surface-active',
  '--surface-hover',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-ghost',
  '--border-subtle',
  '--border-default',
  '--border-strong',
  '--border-panel',
  '--border-chip',
  '--border-popover',
  '--border-selected',
  '--accent',
  '--accent-hover',
  '--accent-tint',
  '--accent-subtle',
  '--focus-ring',
  '--status-backlog',
  '--status-todo',
  '--status-progress',
  '--status-done',
  '--status-cancelled',
  '--status-blocked',
  '--status-green',
  '--priority-urgent',
  '--green',
  '--red',
  '--amber',
  '--teal',
  '--teal-bg',
  '--sky',
  '--sky-bg',
  '--gray',
  '--tooltip-bg',
  '--shadow-panel',
  '--shadow-btn',
  '--shadow-card',
  '--shadow-raised',
  '--shadow-overlay',
  '--shadow-composer',
  '--glass-blur',
  '--glass-saturation',
  '--surface-message',
  '--composer-outline',
  '--scrollbar-thumb',
  '--scrollbar-thumb-hover',
];
test('per-theme tokens exist in light and dark blocks', () => {
  for (const t of perTheme) {
    expect(declares(light, t)).toBe(true);
    expect(declares(dark, t)).toBe(true);
  }
});

// The legacy surface names resolve to the layered set, so the dark block
// restates only the hues (plus `--surface-page`, which the site splitter needs
// in both blocks).
test('legacy surface names alias the Linear surfaces', () => {
  for (const [legacy, target] of [
    ['--surface-page', '--surface-panel'],
    ['--surface-card', '--surface-quaternary'],
    ['--surface-raised', '--surface-popover'],
    ['--surface-muted', '--surface-secondary'],
    ['--surface-inset', '--surface-tertiary'],
    ['--surface-hover-strong', '--surface-active'],
    ['--field', '--surface-secondary'],
  ]) {
    expect(light).toContain(`${legacy}: var(${target});`);
  }
  for (const t of [
    '--surface-card',
    '--surface-raised',
    '--surface-muted',
    '--surface-inset',
    '--field',
  ]) {
    expect(declares(dark, t)).toBe(false);
  }
});

// Every hairline and ring is half a pixel; nothing draws a 1px edge any more.
test('hairlines and rings are 0.5px', () => {
  for (const decl of [
    '--hairline: inset 0 0 0 0.5px var(--border-default);',
    '--hairline-strong: inset 0 0 0 0.5px var(--border-strong);',
    '--hairline-top: inset 0 0.5px 0 var(--border-default);',
    '--hairline-bottom: inset 0 -0.5px 0 var(--border-default);',
    '--hairline-left: inset 0.5px 0 0 var(--border-default);',
    '--hairline-right: inset -0.5px 0 0 var(--border-default);',
    '--shadow-hairline-ring: 0 0 0 0.5px var(--border-default);',
    '--shadow-inset-field: inset 0 0 0 0.5px var(--border-default);',
  ]) {
    expect(tokens).toContain(decl);
  }
  expect(tokens).not.toMatch(/\b1px var\(--border-/);
  expect(tokens.match(/0 0 0 0\.5px/g)?.length ?? 0).toBeGreaterThan(8);
});

// Working is T3 Code's sky and landing is teal, so indigo stays the accent and
// nothing else.
test('run-state hues stay off the accent', () => {
  expect(light).toContain('--state-working-fg: var(--sky);');
  expect(light).toContain('--state-landing-fg: var(--teal);');
  expect(tokens).not.toContain('--state-working-fg: var(--accent)');
  expect(tokens).not.toMatch(/--state-[a-z]+-(fg|surface|edge): var\(--violet/);
});

// Structural tokens are theme-invariant — exactly one declaration each.
test('structural tokens declared once', () => {
  for (const t of [
    '--radius-chip',
    '--radius-control',
    '--radius-card',
    '--radius-popover',
    '--radius-pill',
    '--radius-bubble',
    '--chat-lane-w',
    '--control-h',
    '--row-h',
    '--header-h',
    '--inbox-row-h',
    '--sidebar-w',
    '--icon-size',
    '--avatar-size',
    '--ease-out-expo',
    '--dur-quick',
    '--dur-regular',
    '--dur-slow',
    '--tint-strength',
    '--weight-body',
    '--weight-medium',
    '--weight-semibold',
    '--label-tracking',
    '--meta-tracking',
    '--id-tracking',
    '--font-sans',
    '--font-mono',
  ]) {
    expect(tokens.split(`${t}:`).length - 1).toBe(1);
  }
});

// Linear's geometry: 8px controls and cards, 12px popovers, 4px keycaps.
test('radii and sizes are the Linear values', () => {
  for (const decl of [
    '--radius-chip: 4px;',
    '--radius-control: 8px;',
    '--radius-card: 8px;',
    '--radius-popover: 12px;',
    '--radius-pill: 9999px;',
    '--radius-bubble: 16px;',
    '--chat-lane-w: 736px;',
    '--control-h: 28px;',
    '--row-h: 36px;',
    '--header-h: 44px;',
    '--inbox-row-h: 48px;',
    '--sidebar-w: 244px;',
    '--icon-size: 14px;',
    '--avatar-size: 18px;',
    '--label-tracking: 0;',
    '--meta-tracking: 0;',
    '--id-tracking: -0.26px;',
  ]) {
    expect(tokens).toContain(decl);
  }
});

// The type scale is fixed px on Linear's steps; no rem or clamp anywhere.
test('type scale and spacing are fixed px', () => {
  for (const decl of [
    '--text-2xs: 11px;',
    '--text-xs: 11px;',
    '--text-meta: 12px;',
    '--text-sm: 12px;',
    '--text-base: 13px;',
    '--text-md: 15px;',
    '--text-lg: 18px;',
    '--text-xl: 20px;',
    '--text-micro: 11px;',
    '--text-mini: 12px;',
    '--text-small: 13px;',
    '--text-regular: 15px;',
    '--text-large: 18px;',
    '--text-title3: 20px;',
    '--text-title2: 24px;',
    '--space-1: 4px;',
    '--space-10: 40px;',
    '--weight-body: 400;',
  ]) {
    expect(tokens).toContain(decl);
  }
  expect(tokens).not.toMatch(/\d(rem|vw)\b/);
  expect(tokens).toContain("'Inter Variable'");
});

// tailwind.css forwards every new token as a utility and snaps the stock text
// sizes onto the same scale.
test('tailwind.css exports the Linear tokens', () => {
  for (const decl of [
    '--radius: 8px;',
    '--color-frame: var(--surface-frame);',
    '--color-surface-panel: var(--surface-panel);',
    '--color-surface-popover: var(--surface-popover);',
    '--color-surface-control: var(--surface-control);',
    '--color-surface-selected: var(--surface-selected);',
    '--color-surface-active: var(--surface-active);',
    '--color-border-chip: var(--border-chip);',
    '--color-border-popover: var(--border-popover);',
    '--color-focus-ring: var(--focus-ring);',
    '--color-teal: var(--teal);',
    '--color-status-progress: var(--status-progress);',
    '--color-priority-urgent: var(--priority-urgent);',
    '--radius-pill: var(--radius-pill);',
    '--radius-popover: var(--radius-popover);',
    '--shadow-panel: var(--shadow-panel);',
    '--font-weight-book: 400;',
    '--radius-bubble: var(--radius-bubble);',
    '--shadow-composer: var(--shadow-composer);',
    '--color-sky: var(--sky);',
    '--text-xs: 11px;',
    '--text-sm: 13px;',
    '--text-base: 15px;',
    '--ring: var(--focus-ring);',
    '--sidebar: var(--surface-frame);',
    '--sidebar-accent: var(--surface-selected);',
    '--popover: var(--surface-popover);',
    '--secondary: var(--surface-control);',
  ]) {
    expect(tailwind).toContain(decl);
  }
  expect(tailwind).toContain("'Inter Variable'");
});
