import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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

test('link previews carry an image and the tab an icon', async () => {
  expect(html).toContain(
    '<meta property="og:image" content="https://dispatch.foo/og.png"'
  );
  expect(html).toContain(
    '<meta name="twitter:card" content="summary_large_image"'
  );
  expect(html).toContain('<link rel="icon" href="/favicon.svg"');
  for (const asset of ['og.png', 'favicon.svg']) {
    const file = Bun.file(new URL(`../dist/${asset}`, import.meta.url));
    expect({ asset, exists: await file.exists() }).toEqual({
      asset,
      exists: true,
    });
  }
});

test('the 404 page links home and stays out of search', async () => {
  const notFound = await Bun.file(
    new URL('../dist/404.html', import.meta.url)
  ).text();
  expect(notFound).toContain('<meta name="robots" content="noindex"');
  expect(notFound).not.toContain('rel="canonical"');
  expect(notFound).toContain('href="/"');
});

const manifest = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/protocol-spec/versions/manifest.json',
      import.meta.url
    ),
    'utf8'
  )
) as {
  versions: Record<string, unknown>;
  aliases: Record<string, string>;
  extensions: Record<string, string>;
};

const page = async (path: string): Promise<string> => {
  const file = Bun.file(new URL(`../dist${path}`, import.meta.url));
  expect({ path, exists: await file.exists() }).toEqual({ path, exists: true });
  return file.text();
};

// The site has no .md URLs, so a rendered protocol page must never link to one.
const MD_HREF = /href="[^"]*\.md(?:#[^"]*)?"/;

for (const version of Object.keys(manifest.versions)) {
  test(`renders DMP ${version} with section anchors and the license footer`, async () => {
    const text = await page(`/protocol/${version}/index.html`);
    expect(text).toContain('id="s6.2"');
    expect(text).toContain(
      `Dispatch Messaging Protocol ${version} · Apache-2.0 · source: packages/protocol-spec/`
    );
    expect(text).not.toContain('—');
  });

  test(`renders no .md href in DMP ${version}, and its section links resolve`, async () => {
    const text = await page(`/protocol/${version}/index.html`);
    expect(text).not.toMatch(MD_HREF);
    for (const m of text.matchAll(
      /href="\/protocol\/([^/"]+)\/#(s[0-9A-F.]+)"/g
    )) {
      expect({
        href: m[0],
        ok: m[1] === version && text.includes(`id="${m[2]}"`),
      }).toEqual({ href: m[0], ok: true });
    }
  });

  test(`serves DMP ${version}'s schemas`, async () => {
    const schema: unknown = JSON.parse(
      await page(`/protocol/${version}/schemas/message.schema.json`)
    );
    expect(schema).toHaveProperty('$id');
  });
}

test('the /protocol/ alias carries a canonical link to the immutable path', async () => {
  const text = await page('/protocol/index.html');
  expect(text).toContain(
    `<link rel="canonical" href="https://dispatch.foo/protocol/${manifest.aliases['latest']}/"`
  );
});

// Each extension URI serves §8.3 plus its own §8 subsection.
const EXTENSION_SECTIONS = { envelope: 's8.4', gate: 's8.5', work: 's8.6' };

for (const [name, section] of Object.entries(EXTENSION_SECTIONS)) {
  test(`serves the ${name} extension at its URI, from ${manifest.extensions[name]}`, async () => {
    const text = await page(`/a2a/ext/${name}/v1/index.html`);
    expect(text).toContain(`https://dispatch.foo/a2a/ext/${name}/v1`);
    expect(text).toContain('id="s8.3"');
    expect(text).toContain(`id="${section}"`);
    for (const other of Object.values(EXTENSION_SECTIONS)) {
      if (other !== section) expect(text).not.toContain(`id="${other}"`);
    }
    expect(text).toContain(
      `Dispatch Messaging Protocol ${manifest.extensions[name]} · Apache-2.0`
    );
    expect(text).not.toContain('—');
    expect(text).not.toMatch(MD_HREF);
  });
}

test('the alias pages render no .md href either', async () => {
  const aliases = Object.keys(manifest.aliases)
    .filter((alias) => alias !== 'latest')
    .map((alias) => `/protocol/${alias}/index.html`);
  for (const alias of ['/protocol/index.html', ...aliases]) {
    expect({ alias, md: MD_HREF.test(await page(alias)) }).toEqual({
      alias,
      md: false,
    });
  }
});
