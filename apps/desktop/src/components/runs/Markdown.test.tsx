import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  // Regression: rehype-highlight used to pre-tokenize fenced blocks into <span> elements, so
  // the code renderer's String(children) produced "[object Object]" instead of the source.
  test('a fenced ts block renders its code verbatim', () => {
    const { container } = render(
      <Markdown content={'```ts\nconst x = 1;\n```'} />
    );
    expect(container.textContent).toContain('const x = 1;');
    expect(container.textContent).not.toContain('[object Object]');
    // Rendered through the CodeBlock primitive, which labels the language in its header.
    expect(container.textContent).toContain('TypeScript');
  });

  test('a multi-line fenced block keeps every line', () => {
    const source = 'function add(a, b) {\n  return a + b;\n}';
    const { container } = render(
      <Markdown content={`\`\`\`js\n${source}\n\`\`\``} />
    );
    expect(container.textContent).toContain('function add(a, b) {');
    expect(container.textContent).toContain('return a + b;');
    expect(container.textContent).not.toContain('[object Object]');
  });

  test('a fence without a language tag still renders as a code block', () => {
    const { container } = render(
      <Markdown content={'```\nplain snippet\n```'} />
    );
    expect(container.textContent).toContain('plain snippet');
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  test('inline code stays inline, outside any code block frame', () => {
    const { container } = render(<Markdown content={'use `bun test` here'} />);
    const inline = container.querySelector('code');
    expect(inline?.textContent).toBe('bun test');
    expect(container.querySelector('pre')).toBeNull();
  });
});
