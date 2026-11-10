import { untrustedFenced } from '@dispatch-foo/core/browser';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useEffect } from 'react';

import { Markdown } from './Markdown';

// A settled fence highlights itself asynchronously. Once Shiki has that
// language loaded (another test drew one first) the colours land a few
// microtasks after a synchronous test returns, which is before the shared
// setup's afterEach unmounts it: an update outside act. The fence tests below
// read only what draws at once, so each unmounts before it returns, and the
// late highlight finds nothing mounted to update.

describe('Markdown', () => {
  // A chat re-renders on every streamed delta: a settled message must not
  // remount its code blocks and links each time (or parse again at all).
  test('keeps its code blocks and links mounted when a parent re-renders', () => {
    const content = '[docs](https://example.com)\n\n```ts\nconst a = 1;\n```';
    const { container, rerender } = render(
      <div data-tick="0">
        <Markdown content={content} />
      </div>
    );
    const mounted = () => ({
      link: container.querySelector('a'),
      block: container.querySelector(
        '[data-slot="markdown"] [data-slot="code-block"]'
      ),
    });
    const before = mounted();
    expect(before.link).not.toBeNull();
    expect(before.block).not.toBeNull();
    rerender(
      <div data-tick="1">
        <Markdown content={content} />
      </div>
    );
    const after = mounted();
    expect(after.link === before.link).toBe(true);
    expect(after.block === before.block).toBe(true);
    cleanup();
  });

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
    // Rendered through the CodeBlock primitive, which labels the language in its header
    // and carries the slug as authored on its root.
    expect(container.textContent).toContain('TypeScript');
    expect(
      container
        .querySelector('[data-slot="code-block"]')
        ?.getAttribute('data-language')
    ).toBe('ts');
    cleanup();
  });

  test('a fence wraps its lines on demand, and the toggle says so', () => {
    const { container } = render(
      <Markdown content={'```bash\nbun test\n```'} />
    );
    const block = container.querySelector('[data-slot="code-block"]');
    const toggle = screen.getByRole('button', { name: 'Wrap lines' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(block?.hasAttribute('data-wrap')).toBe(false);
    fireEvent.click(toggle);
    const on = screen.getByRole('button', { name: 'Stop wrapping' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(block?.getAttribute('data-wrap')).toBe('true');
    cleanup();
  });

  test('a fence carries a Copy code button', () => {
    render(<Markdown content={'```ts\nconst x = 1;\n```'} />);
    const copy = screen.getByRole('button', { name: 'Copy code' });
    expect(copy.closest('[data-slot="code-block"]')).not.toBeNull();
    cleanup();
  });

  // The label names the language the fence says: a JavaScript fence is not
  // TypeScript (the old tokenizer's TS-for-JS stand-in is gone with it).
  test.each([
    ['js', 'JavaScript'],
    ['mjs', 'JavaScript'],
    ['javascript', 'JavaScript'],
    ['jsx', 'JSX'],
    ['tsx', 'TSX'],
    ['ts', 'TypeScript'],
  ])('a %s fence is labelled %s', (slug, label) => {
    const { container } = render(
      <Markdown content={`\`\`\`${slug}\nconst x = 1;\n\`\`\``} />
    );
    const block = container.querySelector('[data-slot="code-block"]');
    // The header holds the label; the body holds only the code.
    const header = block?.textContent?.replace('const x = 1;', '') ?? '';
    expect(header).toContain(label);
    if (label !== 'TypeScript') expect(header).not.toContain('TypeScript');
    cleanup();
  });

  test('a fence with an unmapped language tag shows the tag as written', () => {
    const { container } = render(
      <Markdown content={'```bash\nbun test\n```'} />
    );
    expect(container.textContent).toContain('bash');
    cleanup();
  });

  test('a multi-line fenced block keeps every line', () => {
    const source = 'function add(a, b) {\n  return a + b;\n}';
    const { container } = render(
      <Markdown content={`\`\`\`js\n${source}\n\`\`\``} />
    );
    expect(container.textContent).toContain('function add(a, b) {');
    expect(container.textContent).toContain('return a + b;');
    expect(container.textContent).not.toContain('[object Object]');
    cleanup();
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

  test('the prose variant carries the 15px long-form scope; the default inherits', () => {
    const { container } = render(
      <Markdown content="A description." variant="prose" />
    );
    const root = container.querySelector('[data-slot="markdown"]');
    expect(root?.className).toContain('dispatch-md-prose');
    expect(root?.getAttribute('data-variant')).toBe('prose');

    const inline = render(<Markdown content="A line." />);
    const inlineRoot = inline.container.querySelector('[data-slot="markdown"]');
    expect(inlineRoot?.getAttribute('data-variant')).toBe('inline');
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
    cleanup();
  });

  test('$$…$$ is math, a single dollar stays prose', async () => {
    const { container } = render(
      <Markdown
        content={'costs $5 to $10, and $$a^2$$ inline\n\n$$\nx = 1\n$$'}
      />
    );
    const math = container.querySelectorAll('[data-slot="markdown-math"]');
    expect(math).toHaveLength(2);
    expect(math[0]?.getAttribute('data-display')).toBeNull();
    expect(math[0]?.getAttribute('role')).toBe('math');
    expect(math[1]?.getAttribute('data-display')).toBe('true');
    expect(container.textContent).toContain('costs $5 to $10');
    // Math is not a fence: no code block, no inline code.
    expect(container.querySelector('[data-slot="code-block"]')).toBeNull();
    // KaTeX loads lazily, then both formulas are typeset.
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="markdown-math"] .katex')
      ).toHaveLength(2);
    });
  });

  test('a mermaid fence shows its source while the reply streams', () => {
    const { container } = render(
      <Markdown content={'```mermaid\ngraph TD\n  A --> B\n```'} streaming />
    );
    expect(container.querySelector('[data-slot="mermaid-diagram"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="code-block"] pre')
    ).not.toBeNull();
    expect(container.textContent).toContain('A --> B');
  });

  test('a mermaid fence draws a diagram once settled, with a code toggle', () => {
    const { container } = render(
      <Markdown content={'```mermaid\ngraph TD\n  A --> B\n```'} />
    );
    const block = container.querySelector('[data-slot="code-block"]');
    // The diagram stands in for the code inside the same CodeBlock, whose Copy stays.
    expect(
      block?.querySelector('[data-slot="mermaid-diagram"]')
    ).not.toBeNull();
    expect(block?.querySelector('pre')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect(container.querySelector('[data-slot="mermaid-diagram"]')).toBeNull();
    expect(container.textContent).toContain('A --> B');
    expect(screen.getByRole('button', { name: 'Show diagram' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toBeTruthy();
    cleanup();
  });

  test('a wide table sits in its own scroll box', () => {
    const { container } = render(
      <Markdown content={'| a | b |\n| - | - |\n| 1 | 2 |'} />
    );
    expect(
      container.querySelector('.dispatch-md-table > table')
    ).not.toBeNull();
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
