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

test('live demo iframe points at the demo service in embed mode', () => {
  expect(html).toContain(
    'dispatch-demo-production-aed7.up.railway.app/?embed=1'
  );
});

test('positioning survives', () => {
  expect(html).toContain('for agents.');
});

for (const name of ['envelope', 'gate', 'work']) {
  test(`serves the ${name} extension at its URI path with its license line`, async () => {
    const page = Bun.file(
      new URL(`../dist/a2a/ext/${name}/v1/index.html`, import.meta.url)
    );
    expect(await page.exists()).toBe(true);
    const text = await page.text();
    expect(text).toContain(`https://dispatch.foo/a2a/ext/${name}/v1`);
    expect(text).toContain(
      'Licensed MIT; source: packages/a2a/docs/extensions.md'
    );
    expect(text).not.toContain('—');
  });
}
