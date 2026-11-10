import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRef, useState } from 'react';
import { renderToString } from 'react-dom/server';

import { SearchField, type SearchFieldProps } from '../src/index';

afterEach(cleanup);

// SearchField: a native search input named by its label, a leading
// magnifier, a "Clear search" button while it holds text, Escape that
// clears and is stopped only when it cleared something, and onCommit on
// Enter, blur and a clear.

/** A controlled field, as a host renders it. */
function Harness({
  initial = '',
  onCommit,
  ...rest
}: Partial<SearchFieldProps> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <SearchField
      label="Search settings"
      placeholder="Search settings"
      {...rest}
      value={value}
      onChange={setValue}
      onCommit={onCommit}
    />
  );
}

describe('SearchField', () => {
  test('a search box named by its label, the magnifier hidden', () => {
    const { getByRole, container } = render(
      <SearchField
        value="lin"
        onChange={() => undefined}
        label="Search settings"
        placeholder="Find a setting"
        data-testid="settings-search"
      />
    );
    const input = getByRole('searchbox', {
      name: 'Search settings',
    }) as HTMLInputElement;
    expect(input.type).toBe('search');
    expect(input.value).toBe('lin');
    expect(input.getAttribute('placeholder')).toBe('Find a setting');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('enterkeyhint')).toBe('search');
    // The leading icon is decoration.
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    // The host's hook lands on the wrapper, which holds the input.
    const root = container.querySelector('[data-testid="settings-search"]');
    expect(root?.contains(input)).toBe(true);
  });

  test('the clear button shows only while the field holds text', () => {
    const { queryByRole, getByRole } = render(<Harness />);
    expect(queryByRole('button', { name: 'Clear search' })).toBeNull();
    fireEvent.change(getByRole('searchbox'), { target: { value: 'linear' } });
    expect(getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });

  test('clearable={false} never draws it; clearLabel renames it', () => {
    const { queryByRole, rerender, getByRole } = render(
      <SearchField
        value="linear"
        onChange={() => undefined}
        label="Search"
        clearable={false}
      />
    );
    expect(queryByRole('button')).toBeNull();
    rerender(
      <SearchField
        value="linear"
        onChange={() => undefined}
        label="Search"
        clearLabel="Clear find"
      />
    );
    expect(getByRole('button', { name: 'Clear find' })).toBeTruthy();
  });

  test('clearing empties the field, commits, and puts focus back in it', () => {
    const onCommit = mock((_value: string) => {});
    const { getByRole, queryByRole } = render(
      <Harness initial="linear" onCommit={onCommit} />
    );
    const input = getByRole('searchbox') as HTMLInputElement;
    const clear = getByRole('button', { name: 'Clear search' });
    clear.focus();
    fireEvent.click(clear);
    expect(input.value).toBe('');
    expect(onCommit).toHaveBeenLastCalledWith('');
    expect(document.activeElement).toBe(input);
    expect(queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  test('a press on the clear button keeps focus in the field', () => {
    const { getByRole } = render(<Harness initial="linear" />);
    const press = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    getByRole('button', { name: 'Clear search' }).dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  test('the first Escape clears and is stopped; the second reaches the page', () => {
    // A page-level listener (appNav's Escape, which closes Settings)
    // sits above the React root, where React's stopPropagation acts.
    const seen: { defaultPrevented: boolean }[] = [];
    const onPageKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        seen.push({ defaultPrevented: event.defaultPrevented });
      }
    };
    document.addEventListener('keydown', onPageKey);
    const { getByRole } = render(<Harness initial="linear" />);
    const input = getByRole('searchbox') as HTMLInputElement;

    const first = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(first);
    });
    expect(input.value).toBe('');
    expect(first.defaultPrevented).toBe(true);
    // Stopped: the page never saw the first one.
    expect(seen).toEqual([]);

    const second = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
    expect(seen).toEqual([{ defaultPrevented: false }]);
    document.removeEventListener('keydown', onPageKey);
  });

  test('escapeClears={false} leaves Escape alone', () => {
    const onChange = mock((_value: string) => {});
    const { getByRole } = render(
      <SearchField
        value="linear"
        onChange={onChange}
        label="Search"
        escapeClears={false}
      />
    );
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    getByRole('searchbox').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('typing reports each change; Enter and leaving the field commit', () => {
    const onCommit = mock((_value: string) => {});
    const { getByRole } = render(<Harness onCommit={onCommit} />);
    const input = getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'agents' } });
    expect(input.value).toBe('agents');
    expect(onCommit).not.toHaveBeenCalled();
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enter);
    // Kept from submitting a surrounding form.
    expect(enter.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenLastCalledWith('agents');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  test('without onCommit, Enter is left to the page (a form may submit)', () => {
    const { getByRole } = render(
      <SearchField value="x" onChange={() => undefined} label="Search" />
    );
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    getByRole('searchbox').dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
  });

  test('inputRef reaches the input, beside the field’s own ref', () => {
    const ref = createRef<HTMLInputElement>();
    const { getByRole } = render(<Harness initial="x" inputRef={ref} />);
    const input = getByRole('searchbox') as HTMLInputElement;
    expect(ref.current).toBe(input);
    // The field's own ref still works: the clear refocuses the input.
    fireEvent.click(getByRole('button', { name: 'Clear search' }));
    expect(document.activeElement).toBe(input);
  });

  test('renders on the server, the clear button only with text', () => {
    const empty = renderToString(
      <SearchField value="" onChange={() => undefined} label="Search" />
    );
    expect(empty).toContain('type="search"');
    expect(empty).toContain('aria-label="Search"');
    expect(empty).not.toContain('Clear search');
    const full = renderToString(
      <SearchField value="linear" onChange={() => undefined} label="Search" />
    );
    expect(full).toContain('aria-label="Clear search"');
  });
});

describe('search-field.module.css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '../src/tasks/search-field.module.css'),
    'utf8'
  );

  test('the clear button replaces the browser’s own only when clearable', () => {
    expect(css).toMatch(
      /\.clearable \.input::-webkit-search-cancel-button\s*\{\s*display: none;/
    );
  });

  // A size's own font-size has two classes, so the phone rule needs two
  // as well to win, or iOS zooms into a 13.5px md field.
  test('phones and touch screens get 16px fields at either size', () => {
    const flat = css.replace(/\s+/g, ' ');
    const phone = flat.slice(
      flat.indexOf('@media (width <= 640px), (pointer: coarse)')
    );
    expect(phone).toContain('.sm .input, .md .input { font-size: 16px; }');
    expect(phone).toContain('.sm .input { height: var(--h-md); }');
  });

  test('motion only without a reduced-motion preference', () => {
    const motion = css.slice(
      css.indexOf('@media (prefers-reduced-motion: no-preference)')
    );
    expect(motion).toContain('transition:');
    expect(
      css.slice(0, css.indexOf('@media (prefers-reduced-motion'))
    ).not.toContain('transition');
  });
});
