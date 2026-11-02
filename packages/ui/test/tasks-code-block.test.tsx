import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test';

import { CodeBlock, COPIED_MS } from '../src/index';
import { contrast, hex, readCss, THEMES, tokensCss } from './contrast-helpers';

// CodeBlock: code in a <pre><code> on a recessed well, one block span per
// line, an optional header (filename, language, Copy), wrap and maxHeight,
// and a quiet Copy button that says Copied for COPIED_MS, or "Couldn't
// copy" (and selects the code) when the clipboard is missing or refused.

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function mockClipboard(writeText: ((text: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  if (original !== undefined) {
    Object.defineProperty(navigator, 'clipboard', original);
  }
});

/** Clicks and lets the clipboard promise settle. */
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
}

/** The block's root, by its slot. */
function root(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    '[data-slot="code-block"]'
  );
  if (found === null) throw new Error('no code block');
  return found;
}

describe('CodeBlock', () => {
  test('renders a pre > code holding the code, one block span per line', () => {
    const { container } = render(
      <CodeBlock code={'const a = 1;\nconst b = 2;'} copy={false} />
    );
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    const lines = [...(code?.children ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual([
      'const a = 1;\n',
      'const b = 2;',
    ]);
    expect(code?.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  test('an empty middle line renders a space, and a final newline adds no line', () => {
    const { container } = render(
      <CodeBlock code={'first\n\nthird\n'} copy={false} />
    );
    const lines = [...(container.querySelector('code')?.children ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual([
      'first\n',
      ' \n',
      'third',
    ]);
  });

  test('the filename (in the mono class) and the language label show in the header', () => {
    mockClipboard(() => Promise.resolve());
    const { getByText, getByRole } = render(
      <CodeBlock code="{}" filename="src/app.ts" language="TypeScript" />
    );
    const filename = getByText('src/app.ts');
    expect(filename.getAttribute('title')).toBe('src/app.ts');
    const language = getByText('TypeScript');
    // Both sit in the header row, in that order, with the Copy button at
    // its end, and none of it is in the code.
    const button = getByRole('button', { name: 'Copy code' });
    const header = button.parentElement;
    expect(header?.firstElementChild).toBe(filename);
    expect(filename.nextElementSibling).toBe(language);
    expect(header?.lastElementChild).toBe(button);
    expect(header?.closest('pre')).toBeNull();
    // CSS modules are empty objects under Bun, so the classes are checked
    // in the sheet: the filename's sets Geist Mono, the language's stays
    // sans.
    const css = readCss('tasks/code-block.module.css').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.filename \{[^}]*font-family: var\(--font-mono\);/);
    expect(css).toMatch(/\.language \{[^}]*font-family: var\(--font-body\);/);
  });

  test('no filename, language or copy: no header row at all', () => {
    const { container } = render(<CodeBlock code="x" copy={false} />);
    const block = root(container);
    expect(block.children).toHaveLength(1);
    expect(block.firstElementChild?.tagName).toBe('PRE');
    expect(block.querySelector('button')).toBeNull();
    expect(block.querySelector('[aria-live]')).toBeNull();
  });

  test('wrap sets data-wrap on the root; it is absent by default', () => {
    const { container, rerender } = render(<CodeBlock code="x" />);
    expect(root(container).hasAttribute('data-wrap')).toBe(false);
    rerender(<CodeBlock code="x" wrap />);
    expect(root(container).getAttribute('data-wrap')).toBe('true');
  });

  test('maxHeight caps the body: a number is px, a string passes through', () => {
    const { container, rerender } = render(
      <CodeBlock code="x" maxHeight={240} />
    );
    const pre = () => container.querySelector('pre');
    expect(pre()?.style.maxHeight).toBe('240px');
    rerender(<CodeBlock code="x" maxHeight="50vh" />);
    expect(pre()?.style.maxHeight).toBe('50vh');
    rerender(<CodeBlock code="x" />);
    expect(pre()?.style.maxHeight).toBe('');
  });

  test('copy={false} renders no button', () => {
    const { queryByRole } = render(<CodeBlock code="x" copy={false} />);
    expect(queryByRole('button')).toBeNull();
  });

  test('a host’s data-* hooks land on the root, beside its own slot', () => {
    const { getByTestId } = render(
      <CodeBlock code="x" data-testid="fence" data-language-tag="ts" />
    );
    const block = getByTestId('fence');
    expect(block.getAttribute('data-slot')).toBe('code-block');
    expect(block.getAttribute('data-language-tag')).toBe('ts');
  });

  test('tokens draw each line as the host’s runs, carrying their custom properties', () => {
    const { container } = render(
      <CodeBlock
        code={'const a = 1;\n\nb'}
        copy={false}
        tokens={[
          [
            { content: 'const', vars: { '--shiki-light': 'red' } },
            { content: ' a = 1;' },
          ],
          [],
          [{ content: 'b', vars: { '--shiki-dark': 'blue' } }],
        ]}
      />
    );
    const code = container.querySelector('pre > code');
    // The text, and so a hand copy, is the code exactly.
    expect(code?.textContent).toBe('const a = 1;\n \nb');
    const runs = [...container.querySelectorAll('[data-code-token]')];
    expect(runs.map((run) => run.textContent)).toEqual([
      'const',
      ' a = 1;',
      'b',
    ]);
    expect(
      (runs[0] as HTMLElement).style.getPropertyValue('--shiki-light')
    ).toBe('red');
    expect((runs[1] as HTMLElement).getAttribute('style')).toBeNull();
    expect(
      (runs[2] as HTMLElement).style.getPropertyValue('--shiki-dark')
    ).toBe('blue');
    // The blank line keeps its space and its height.
    expect(code?.children[1]?.textContent).toBe(' \n');
  });

  test('tokens that do not draw the code are ignored: the plain lines show', () => {
    const { container, rerender } = render(
      <CodeBlock
        code={'one\ntwo'}
        copy={false}
        tokens={[[{ content: 'one' }]]}
      />
    );
    expect(container.querySelector('[data-code-token]')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('one\ntwo');
    rerender(
      <CodeBlock
        code={'one\ntwo'}
        copy={false}
        tokens={[[{ content: 'one' }], [{ content: 'tw' }]]}
      />
    );
    expect(container.querySelector('[data-code-token]')).toBeNull();
  });

  test('actions sit in the header before Copy, and a header shows for them alone', () => {
    mockClipboard(() => Promise.resolve());
    const { getByRole, container, rerender } = render(
      <CodeBlock
        code="x"
        language="json"
        actions={<button type="button">Wrap lines</button>}
      />
    );
    const wrap = getByRole('button', { name: 'Wrap lines' });
    const copy = getByRole('button', { name: 'Copy code' });
    const header = copy.parentElement;
    expect(wrap.parentElement?.parentElement).toBe(header);
    expect(wrap.parentElement?.nextElementSibling).toBe(copy);
    expect(header?.closest('pre')).toBeNull();
    rerender(
      <CodeBlock
        code="x"
        copy={false}
        actions={<button type="button">Wrap lines</button>}
      />
    );
    const block = root(container);
    expect(block.children).toHaveLength(2);
    expect(block.lastElementChild?.tagName).toBe('PRE');
    const css = readCss('tasks/code-block.module.css').replace(/\s+/g, ' ');
    expect(css).toContain('.actions + .copy { margin-inline-start: 0; }');
  });

  test('children draw in place of the code, and Copy still writes the code', async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    mockClipboard(writeText);
    const { container, getByRole, getByTestId } = render(
      <CodeBlock code={'graph TD\n  A --> B'} language="mermaid">
        <div data-testid="diagram">A diagram</div>
      </CodeBlock>
    );
    expect(container.querySelector('pre')).toBeNull();
    expect(getByTestId('diagram').parentElement).toBe(root(container));
    await click(getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('graph TD\n  A --> B');
  });

  test('className adds to the root', () => {
    const { container } = render(<CodeBlock code="x" className="host-fence" />);
    expect(root(container).classList.contains('host-fence')).toBe(true);
  });

  test('copies the code, reads Copied for COPIED_MS, then Copy again', async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    mockClipboard(writeText);
    const code = '{\n  "ok": true\n}\n';
    const { getByRole, container } = render(
      <CodeBlock code={code} language="json" />
    );
    const button = getByRole('button', { name: 'Copy code' });
    expect(button.textContent).toBe('Copy');
    expect(button.getAttribute('data-variant')).toBe('quiet');
    await click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    // The exact text, final newline and all.
    expect(writeText.mock.calls[0]?.[0]).toBe(code);
    expect(button.textContent).toBe('Copied');
    expect(button.getAttribute('aria-label')).toBe('Copied');
    expect(button.getAttribute('data-state')).toBe('copied');
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Copied');

    act(() => {
      jest.advanceTimersByTime(COPIED_MS - 1);
    });
    expect(button.textContent).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(button.textContent).toBe('Copy');
    expect(button.getAttribute('aria-label')).toBe('Copy code');
    expect(button.getAttribute('data-state')).toBe('idle');
    expect(live?.textContent).toBe('');
  });

  test('copyLabel names the button', () => {
    const { getByRole } = render(
      <CodeBlock code="x" copyLabel="Copy the tool input" />
    );
    expect(getByRole('button', { name: 'Copy the tool input' })).toBeTruthy();
  });

  test('a refused clipboard reads Couldn’t copy and selects the code', async () => {
    mockClipboard(() => Promise.reject(new Error('denied')));
    const { getByRole, container } = render(
      <CodeBlock code={'echo one\necho two'} />
    );
    const button = getByRole('button', { name: 'Copy code' });
    await click(button);
    expect(button.textContent).toBe("Couldn't copy");
    expect(button.getAttribute('aria-label')).toBe("Couldn't copy");
    expect(button.getAttribute('data-state')).toBe('failed');
    expect(window.getSelection()?.toString()).toBe('echo one\necho two');
    expect(
      container.querySelector('[aria-live="polite"]')?.textContent
    ).toContain("Couldn't copy");
    act(() => {
      jest.advanceTimersByTime(COPIED_MS);
    });
    expect(button.textContent).toBe('Copy');
  });

  test('no clipboard at all (an insecure origin) also reads Couldn’t copy', async () => {
    mockClipboard(null);
    const { getByRole } = render(<CodeBlock code="x" />);
    const button = getByRole('button', { name: 'Copy code' });
    await click(button);
    expect(button.textContent).toBe("Couldn't copy");
  });

  test('unmounting clears the timer', async () => {
    mockClipboard(() => Promise.resolve());
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    const { getByRole, unmount } = render(<CodeBlock code="x" />);
    await click(getByRole('button', { name: 'Copy code' }));
    const before = clear.mock.calls.length;
    unmount();
    expect(clear.mock.calls.length).toBe(before + 1);
    clear.mockRestore();
  });

  test('a body that does not scroll takes no tab stop', () => {
    const { container } = render(<CodeBlock code="short" />);
    const pre = container.querySelector('pre');
    expect(pre?.hasAttribute('tabindex')).toBe(false);
    expect(pre?.hasAttribute('data-scrollable')).toBe(false);
    expect(pre?.hasAttribute('role')).toBe(false);
    expect(pre?.hasAttribute('aria-label')).toBe(false);
  });

  // happy-dom lays nothing out (every scroll size is 0), so a wide body is
  // faked: its content 400px wide in a 100px box.
  describe('a body that scrolls', () => {
    const sizes = ['scrollWidth', 'clientWidth'] as const;
    const saved = sizes.map(
      (name): [string, PropertyDescriptor | undefined] => [
        name,
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
      ]
    );

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get: () => 400,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => 100,
      });
    });

    afterEach(() => {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(HTMLElement.prototype, name);
        } else {
          Object.defineProperty(HTMLElement.prototype, name, descriptor);
        }
      }
    });

    test.each([
      [{ filename: 'src/a.ts', language: 'TypeScript' }, 'src/a.ts'],
      [{ language: 'JSON' }, 'JSON code'],
      [{}, 'Code'],
    ])(
      'takes a tab stop and is a named region: %o',
      (extra: { filename?: string; language?: string }, name: string) => {
        const { container } = render(
          <CodeBlock code={'x'.repeat(200)} {...extra} />
        );
        const pre = container.querySelector('pre');
        expect(pre?.getAttribute('tabindex')).toBe('0');
        expect(pre?.getAttribute('data-scrollable')).toBe('true');
        expect(pre?.getAttribute('role')).toBe('region');
        expect(pre?.getAttribute('aria-label')).toBe(name);
      }
    );
  });
});

describe('code-block.module.css', () => {
  const css = readCss('tasks/code-block.module.css');
  const flat = css.replace(/\s+/g, ' ');

  test('tokens only: no hex, and every var() it reads is a token', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|hsl)a?\(/i);
    const declared = new Set(
      [...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
    );
    const read = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(8);
    expect(read.filter((name) => !declared.has(name))).toEqual([]);
  });

  test('the well: sunken, bordered, rounded, Geist Mono 12px, scrolling unless wrapped', () => {
    expect(flat).toMatch(/\.pre \{[^}]*border: 1px solid var\(--border\);/);
    expect(flat).toMatch(/\.pre \{[^}]*border-radius: var\(--r\);/);
    expect(flat).toMatch(/\.pre \{[^}]*background: var\(--sunken\);/);
    expect(flat).toMatch(/\.pre \{[^}]*font-family: var\(--font-mono\);/);
    expect(flat).toMatch(/\.pre \{[^}]*font-size: var\(--fs-xs\);/);
    expect(flat).toMatch(/\.pre \{[^}]*overflow: auto;/);
    expect(flat).toMatch(/\.pre \{[^}]*scrollbar-width: thin;/);
    expect(flat).toMatch(/\.pre \{[^}]*white-space: pre;/);
    expect(flat).toContain(
      ".root[data-wrap='true'] .pre { white-space: pre-wrap; overflow-wrap: anywhere; }"
    );
    expect(flat).toMatch(/\.line \{ display: block; \}/);
  });

  test('no colour of its own, no motion, no dropped ring, and forced colours keep the edges', () => {
    expect(flat).not.toMatch(/(?:transition|animation):/);
    expect(flat).not.toMatch(/outline:\s*(none|0)\b/);
    expect(flat).not.toContain('uppercase');
    // One text colour for all of the code: a host's highlighter colours
    // its runs from its own sheet, so the module names no hue.
    expect(flat).not.toMatch(/--(red|green|blue|amber|violet|teal)\b/);
    expect(flat).toMatch(
      /@media \(forced-colors: active\) \{ \.pre \{ border-color: CanvasText; \} \.copy \{ border-color: ButtonText; \} \}/
    );
  });

  test('the code, the filename and the language hold 4.5:1 where they sit, in both themes', () => {
    for (const [theme, t] of THEMES) {
      const pairs = [
        ['--text', '--sunken'],
        ['--text', '--surface'],
        ['--text-3', '--surface'],
        ['--text-3', '--bg'],
      ] as const;
      const failing = pairs
        .map(([ink, ground]) => ({
          pair: `${theme}: ${ink} on ${ground}`,
          ratio: contrast(hex(t, ink), hex(t, ground)),
        }))
        .filter(({ ratio }) => ratio < 4.5);
      expect(failing).toEqual([]);
    }
  });
});
