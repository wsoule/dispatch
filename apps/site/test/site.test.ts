import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { shots, WIDTHS } from '../src/data/shots';
import type { Shot } from '../src/data/shots';
import { DMG, INSTALL, VERSION } from '../src/lib/downloads';

const page = async (path: string): Promise<string> => {
  const file = Bun.file(new URL(`../dist${path}`, import.meta.url));
  if (!(await file.exists())) {
    throw new Error(
      `dist${path} missing. Run \`moon run site:build\` (or \`moon run site:test\`).`
    );
  }
  return file.text();
};

const html = await page('/index.html');
const PAGES = [
  'download',
  'docs',
  'hub',
  'pricing',
  'faq',
  'changelog',
  'privacy',
];

test('the home page leads with the install line and the DMG', () => {
  expect(html).toContain(INSTALL);
  expect(html).toContain(`href="${DMG}"`);
});

test('the DMG link names its version tag, not latest', () => {
  expect(DMG).toBe(
    `https://github.com/wsoule/dispatch/releases/download/app-v${VERSION}/Dispatch_${VERSION}_universal.dmg`
  );
});

test('no page promises what the new product dropped', async () => {
  for (const path of ['/index.html', ...PAGES.map((p) => `/${p}/index.html`)]) {
    const text = (await page(path)).toLowerCase();
    for (const gone of [
      'app.dispatch.foo',
      'license key',
      'relay',
      'brew install',
      'demo.dispatch.foo',
      '/clips',
      'three people',
    ]) {
      expect({ path, gone, found: text.includes(gone) }).toEqual({
        path,
        gone,
        found: false,
      });
    }
  }
});

test('no em-dashes anywhere on the marketing pages', async () => {
  for (const path of ['/index.html', ...PAGES.map((p) => `/${p}/index.html`)]) {
    expect({ path, dash: (await page(path)).includes('—') }).toEqual({
      path,
      dash: false,
    });
  }
});

test('every screenshot slot ships every file it names', async () => {
  for (const [slot, shot] of Object.entries(shots) as [string, Shot][]) {
    const themes = shot.darkOnly === true ? ['dark'] : ['light', 'dark'];
    for (const theme of themes)
      for (const w of WIDTHS) {
        const name = `${shot.file}-${theme}-${w}.webp`;
        const file = Bun.file(
          new URL(`../dist/shots/${name}`, import.meta.url)
        );
        expect({ slot, name, exists: await file.exists() }).toEqual({
          slot,
          name,
          exists: true,
        });
      }
  }
});

test('every page has its own canonical, and no line break swallows a space', async () => {
  for (const name of PAGES) {
    const text = await page(`/${name}/index.html`);
    expect(text).toContain(
      `<link rel="canonical" href="https://dispatch.foo/${name}"`
    );
    expect({
      name,
      glued: text.match(/[A-Za-z,.]<(a|code|strong)[ >]/)?.[0] ?? null,
    }).toEqual({ name, glued: null });
  }
});

test('pricing names Solo and Team at $10 per seat', async () => {
  const pricing = await page('/pricing/index.html');
  expect(pricing).toContain('Solo');
  expect(pricing).toContain('$10');
  expect(pricing).toContain('per seat per month');
});

test('docs give the real team sign-in steps', async () => {
  const docs = await page('/docs/index.html');
  for (const step of [
    'server login https://team.dispatch.foo',
    'machine add team --server https://team.dispatch.foo',
    'team found',
    'project add',
    'project share',
  ]) {
    expect({ step, found: docs.includes(step) }).toEqual({ step, found: true });
  }
});

test('the team service links its own privacy policy and terms', () => {
  expect(html).toContain('href="https://team.dispatch.foo/privacy"');
  expect(html).toContain('href="https://team.dispatch.foo/terms"');
});

test('link previews carry an image and the tab an icon', async () => {
  expect(html).toContain(
    '<meta property="og:image" content="https://dispatch.foo/og.png"'
  );
  for (const asset of ['og.png', 'favicon.svg']) {
    const file = Bun.file(new URL(`../dist/${asset}`, import.meta.url));
    expect({ asset, exists: await file.exists() }).toEqual({
      asset,
      exists: true,
    });
  }
});

test('the 404 page links home and stays out of search', async () => {
  const notFound = await page('/404.html');
  expect(notFound).toContain('<meta name="robots" content="noindex"');
  expect(notFound).not.toContain('rel="canonical"');
  expect(notFound).toContain('href="/"');
});

// Every page's JSON-LD graph, parsed: a syntax error fails here.
const graphOf = (text: string): { '@type': string }[] => {
  const raw = text.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
  )?.[1];
  expect(raw).toBeDefined();
  return (JSON.parse(raw ?? '{}') as { '@graph': { '@type': string }[] })[
    '@graph'
  ];
};

test('the home page describes the app as structured data', () => {
  expect(graphOf(html).map((n) => n['@type'])).toEqual([
    'Organization',
    'WebSite',
    'SoftwareApplication',
  ]);
});

test('/faq answers every question as visible text and as FAQPage data', async () => {
  const faq = await page('/faq/index.html');
  const graph = graphOf(faq) as unknown as {
    '@type': string;
    mainEntity?: { name: string }[];
  }[];
  const questions =
    graph.find((n) => n['@type'] === 'FAQPage')?.mainEntity ?? [];
  expect(questions.length).toBeGreaterThan(15);
  for (const { name } of questions) {
    expect(faq).toContain(`>${name.replace(/'/g, '&#39;')}</dt>`);
  }
  expect(new Set(questions.map((q) => q.name)).size).toBe(questions.length);
});

test('robots.txt allows every crawler and points at the sitemap', async () => {
  const robots = await page('/robots.txt');
  expect(robots).toContain('User-agent: *\nAllow: /');
  expect(robots).not.toContain('Disallow');
  expect(robots).toContain('Sitemap: https://dispatch.foo/sitemap.xml');
});

test('every sitemap URL is a built page whose canonical is that URL', async () => {
  const sitemap = await page('/sitemap.xml');
  const locs = [
    ...sitemap.matchAll(/<loc>https:\/\/dispatch\.foo([^<]*)<\/loc>/g),
  ].map((m) => m[1] ?? '');
  expect(locs).toEqual(['/', ...PAGES.map((p) => `/${p}`)]);
  for (const loc of locs) {
    const built = await page(loc === '/' ? '/index.html' : `${loc}/index.html`);
    expect({
      loc,
      canonical: built.match(/rel="canonical" href="([^"]+)"/)?.[1],
    }).toEqual({ loc, canonical: `https://dispatch.foo${loc}` });
  }
});

test('llms.txt briefs AI answer engines with the version and install line', async () => {
  const llms = await page('/llms.txt');
  expect(llms.startsWith('# Dispatch\n\n> ')).toBe(true);
  expect(llms).toContain(`Current version: ${VERSION}.`);
  expect(llms).toContain(INSTALL);
  expect(llms).toContain('### The basics');
});

// The old protocol pages still build, unlinked, until the spec is rewritten
// or retired. They must keep rendering without .md links.
const manifest = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/protocol-spec/versions/manifest.json',
      import.meta.url
    ),
    'utf8'
  )
) as { versions: Record<string, unknown> };

for (const version of Object.keys(manifest.versions)) {
  test(`still renders DMP ${version}`, async () => {
    const text = await page(`/protocol/${version}/index.html`);
    expect(text).toContain('id="s6.2"');
    expect(text).not.toMatch(/href="[^"]*\.md(?:#[^"]*)?"/);
  });
}

test('no marketing page links the old protocol pages', async () => {
  for (const path of ['/index.html', ...PAGES.map((p) => `/${p}/index.html`)]) {
    const text = await page(path);
    expect({ path, linked: /href="\/(protocol|a2a)\//.test(text) }).toEqual({
      path,
      linked: false,
    });
  }
});
