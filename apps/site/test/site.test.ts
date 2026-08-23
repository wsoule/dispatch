import { expect, test } from 'bun:test';

const distIndex = Bun.file(new URL('../dist/index.html', import.meta.url));
if (!(await distIndex.exists())) {
  throw new Error(
    'dist/index.html missing. Run `bun run build` (or `bun run test`) in apps/site.'
  );
}
const html = await distIndex.text();

test('install command is on the page', () => {
  expect(html).toContain('brew install --cask wsoule/tap/dispatch');
});

test('no em-dashes anywhere on the page', () => {
  expect(html).not.toContain('—');
});

test('live demo iframe points at the demo service', () => {
  expect(html).toContain('dispatch-demo-production-aed7.up.railway.app');
});

test('positioning survives', () => {
  expect(html).toContain('for agents.');
});
