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
  expect(out).toContain(':root{--surface-page: #fafafb;');
  expect(out).toContain(':root[data-theme="dark"]{--surface-page: #17181a;');
});

test('a stylesheet with two dark blocks is rejected', () => {
  expect(() => themeAwareTokens(`${sample}${sample}`)).toThrow();
});
