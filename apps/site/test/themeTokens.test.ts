import { expect, test } from 'bun:test';

import { themeAwareTokens } from '../src/lib/themeTokens';

const sample = `:root {
  /* a comment with an em dash — in it */
  --surface-page: #fff;
  --text-primary: #000;
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface-page: #000;
    --text-primary: #fff;
  }
}
`;

test('light palette stays on :root', () => {
  const out = themeAwareTokens(sample);
  expect(out).toContain(':root{--surface-page: #fff; --text-primary: #000;}');
});

test('dark palette is reachable by media query and by data-theme', () => {
  const out = themeAwareTokens(sample);
  expect(out).toContain(
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--surface-page: #000;'
  );
  expect(out).toContain(':root[data-theme="dark"]{--surface-page: #000;');
});

test('comments are dropped', () => {
  expect(themeAwareTokens(sample)).not.toContain('—');
});

test('the real tokens.css splits cleanly', async () => {
  const real = await Bun.file(
    Bun.resolveSync('@dispatch/tokens/tokens.css', import.meta.dir)
  ).text();
  const out = themeAwareTokens(real);
  // The frame is the first token in each block; the page surface aliases the panel.
  expect(out).toContain(':root{--surface-frame: #efeff0;');
  expect(out).toContain('--surface-page: var(--surface-panel);');
  expect(out).toContain(':root[data-theme="dark"]{--surface-frame: #08080a;');
});

// The shape the splitter relies on, stated outright: one light `:root` block, one dark media
// block, and `--surface-page` (the first name Base.astro reads) declared in both halves. The
// desktop app no longer loads this palette, so this is the one place that guards its shape.
test('the real tokens.css is one light block and one dark block', async () => {
  const real = await Bun.file(
    Bun.resolveSync('@dispatch/tokens/tokens.css', import.meta.dir)
  ).text();
  const [light, dark, ...rest] = real.split(
    '@media (prefers-color-scheme: dark)'
  );
  expect(rest).toEqual([]);
  expect(light).toContain('--surface-page:');
  expect(dark).toContain('--surface-page:');
});

test('a stylesheet with two dark blocks is rejected', () => {
  expect(() => themeAwareTokens(`${sample}${sample}`)).toThrow();
});
