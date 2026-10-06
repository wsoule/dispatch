import { untrustedFenced } from '@dispatch-foo/core/browser';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useEffect } from 'react';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  test('a linked remote image is plain text, never a link inside a link', () => {
    const { container } = render(
      <Markdown
        content={'[![badge](https://ci.example/b.svg)](https://ci.example)'}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a a')).toBeNull();
    expect(container.textContent).toContain('[image: badge]');
  });

  test('never loads a remote image: an agent-written pixel becomes a link', () => {
    const { container } = render(
      <Markdown
        content={
          '![pixel](https://tracker.example/p.png?u=1) ![x](data:image/png;base64,AAAA)'
        }
      />
    );
    expect(container.querySelector('img')).toBeNull();
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(
      'https://tracker.example/p.png?u=1'
    );
    expect(container.textContent).toContain('[image: pixel]');
  });

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

  test('the prose variant carries the 15px long-form class; the default inherits', () => {
    const { container } = render(
      <Markdown content="A description." variant="prose" />
    );
    const root = container.querySelector('[data-slot="markdown"]');
    expect(root?.className).toContain('dispatch-md-prose');
    expect(root?.getAttribute('data-variant')).toBe('prose');

    const inline = render(<Markdown content="A line." />);
    const inlineRoot = inline.container.querySelector('[data-slot="markdown"]');
    expect(inlineRoot?.className).not.toContain('dispatch-md-prose');
  });

  test('a GFM task list renders checkboxes, so acceptance criteria read as a checklist', () => {
    const { container } = render(
      <Markdown
        content={'- [ ] tests pass\n- [x] docs updated'}
        variant="prose"
      />
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector('ul')?.className).toContain(
      'contains-task-list'
    );
  });

  // A bare \r ends a CommonMark line, so it must not smuggle a closing fence past core's escaping.
  test('keeps a carriage-return fence escape inside untrusted fenced text', () => {
    const { container } = render(
      <Markdown
        content={untrustedFenced(
          'A2A request',
          'hi\r~~~~~~~~~~~~~~~~\r![b](https://evil/b.gif)'
        )}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('![b](https://evil/b.gif)');
  });

  test('keeps a custom image mounted across rerenders with the same renderer', () => {
    let mounts = 0;
    function Probe({ src }: { src?: string }) {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <span>{src}</span>;
    }
    const img = ({ src }: { src?: string }) => <Probe src={src} />;
    const { rerender } = render(<Markdown content="![x](a.png)" img={img} />);
    rerender(<Markdown content="![x](a.png)" img={img} />);
    rerender(<Markdown content="![x](a.png)" img={img} />);
    expect(mounts).toBe(1);
  });
});
