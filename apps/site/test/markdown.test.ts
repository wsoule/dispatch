import { expect, it } from 'bun:test';
import { pathToFileURL } from 'node:url';

import { markdownProcessor } from '../src/lib/markdown';

// Renders markdown as a frozen spec file, through the processor the site uses.
async function render(markdown: string): Promise<string> {
  const renderer = await markdownProcessor().createRenderer({
    syntaxHighlight: false,
  });
  const fileURL = pathToFileURL(
    '/r/packages/protocol-spec/versions/1.0.0/spec/05-gates.md'
  );
  return (await renderer.render(markdown, { fileURL })).code;
}

it('gives the DMP text its section anchors and site links', async () => {
  const code = await render(
    '## 5.9 The wake gate\n\nSee [§6.2](06-delivery.md#s6.2).'
  );
  expect(code).toContain('<h2 id="s5.9">');
  expect(code).toContain('href="/protocol/1.0.0/#s6.2"');
});

it('renders quoted literal values as written', async () => {
  const code = await render(
    `The sentence is "Waiting for the owner." -- it's fixed.`
  );
  expect(code).toContain(`"Waiting for the owner." -- it's fixed.`);
});
