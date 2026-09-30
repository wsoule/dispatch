import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const read = (path: string) => Bun.file(path).text();
const ours = await read(join(import.meta.dir, 'preflight.css'));
const theirs = await read(
  join(
    dirname(Bun.resolveSync('tailwindcss/package.json', import.meta.dir)),
    'preflight.css'
  )
);

// Comments and whitespace out, one quote style, so only the rules themselves compare.
function normalize(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
}

// Tailwind upgrades its preflight now and then; this fails until the copy is redone.
test('the vendored preflight is Tailwind’s but for the pseudo-element reset', () => {
  const expected = normalize(theirs)
    .replace(
      '*,::after,::before,::backdrop,::file-selector-button{',
      "*,::backdrop,::file-selector-button,[class*='before:']::before,[class*='after:']::after{"
    )
    .replaceAll('--theme(', 'var(');
  expect(normalize(ours)).toBe(expected);
});

// A rule reaching every element's ::before/::after makes WebKit style both for every element.
test('no stylesheet styles every element’s ::before or ::after', async () => {
  const universal = /(?:^|[,{}])\*?::?(?:before|after)[,{]/;
  const sheets = readdirSync(import.meta.dir).filter((name) =>
    name.endsWith('.css')
  );
  expect(sheets).toContain('global.css');
  for (const name of sheets) {
    const css = normalize(await read(join(import.meta.dir, name)));
    expect({ name, universal: universal.test(css) }).toEqual({
      name,
      universal: false,
    });
  }
});
