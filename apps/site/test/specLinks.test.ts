import { satteri } from '@astrojs/markdown-satteri';
import { expect, it } from 'bun:test';
import { pathToFileURL } from 'node:url';

import { specHref, specLinks, versionOfPath } from '../src/lib/specLinks';

it('rewrites spec-file links to the frozen version page and its anchor', () => {
  expect(specHref('03-addresses.md#s3.4', '1.0.0-draft.1')).toBe(
    '/protocol/1.0.0-draft.1/#s3.4'
  );
  expect(specHref('08-a2a-binding.md#s8.4', '1.0.0-draft.1')).toBe(
    '/protocol/1.0.0-draft.1/#s8.4'
  );
  expect(specHref('appendix-c-dispatch-profile.md#sC.3', '1.0.0')).toBe(
    '/protocol/1.0.0/#sC.3'
  );
});

it("sends a fragment-less link to the file's first section", () => {
  expect(specHref('03-addresses.md', '1.0.0')).toBe('/protocol/1.0.0/#s3');
  expect(specHref('appendix-f-federation.md', '1.0.0')).toBe(
    '/protocol/1.0.0/#sF'
  );
});

it('leaves every other href alone', () => {
  expect(specHref('https://a2a-protocol.org/', '1.0.0')).toBeNull();
  expect(specHref('#s6.2', '1.0.0')).toBeNull();
  expect(specHref('../CHANGELOG.md', '1.0.0')).toBeNull();
});

it('reads the frozen version from the rendered file path', () => {
  expect(
    versionOfPath(
      '/r/packages/protocol-spec/versions/1.0.0-draft.2/spec/05-gates.md'
    )
  ).toBe('1.0.0-draft.2');
  expect(
    versionOfPath('/r/packages/protocol-spec/spec/05-gates.md')
  ).toBeNull();
});

// Renders markdown as the file at `path`, through Astro's markdown processor
// with only this plugin added.
async function render(markdown: string, path: string): Promise<string> {
  const renderer = await satteri({ hastPlugins: [specLinks()] }).createRenderer(
    { syntaxHighlight: false }
  );
  return (await renderer.render(markdown, { fileURL: pathToFileURL(path) }))
    .code;
}

it('rewrites the links of a file under versions/<v>/spec/', async () => {
  const code = await render(
    'See [§5.9](05-gates.md#s5.9) and [A2A](https://a2a-protocol.org).',
    '/r/packages/protocol-spec/versions/1.0.0/spec/06-delivery.md'
  );
  expect(code).toContain('href="/protocol/1.0.0/#s5.9"');
  expect(code).toContain('href="https://a2a-protocol.org"');
});

it('leaves the links of an unreleased file alone', async () => {
  const code = await render(
    'See [§5.9](05-gates.md#s5.9).',
    '/r/packages/protocol-spec/spec/06-delivery.md'
  );
  expect(code).toContain('href="05-gates.md#s5.9"');
});
