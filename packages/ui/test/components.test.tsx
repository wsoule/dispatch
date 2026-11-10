import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';

import {
  type BlockBarProps,
  type ConfirmDialogProps,
  cx,
  type DataAttributes,
  type DialogProps,
  type PickerMarkViewProps,
  type PopoverProps,
  type SpinnerProps,
  type StatusMarkProps,
  type TabItem,
  Tabs,
  type TabsProps,
  ThemeToggle,
  type ThemeToggleProps,
  type TooltipProps,
  type UiLinkProviderProps,
} from '../src/index';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

const items: TabItem[] = [
  { id: 'overview', label: 'Overview', content: 'First panel' },
  { id: 'more', label: 'More', content: 'Second panel' },
];

describe('Tabs', () => {
  test('two strips with the same item ids keep their own tab/panel pairs', () => {
    render(
      <>
        <Tabs items={items} label="Milestone sections" />
        <Tabs items={items} />
      </>
    );
    const ids = Array.from(document.querySelectorAll('[id]')).map(
      (el) => el.id
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of screen.getAllByRole('tab')) {
      const panel = document.getElementById(
        tab.getAttribute('aria-controls') ?? ''
      );
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(
      screen.getByRole('tablist', { name: 'Milestone sections' })
    ).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
  });

  test('an empty list renders nothing instead of throwing', () => {
    expect(renderToString(<Tabs items={[]} />)).toBe('');
  });

  test('arrow keys still move the selection', () => {
    render(<Tabs items={items} />);
    const [first, second] = screen.getAllByRole('tab');
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Second panel').hidden).toBe(false);
  });

  // The strip sits in the global page column. That class is part of the
  // sheet's documented contract (README "Styles"), not a hashed module
  // class, and it is `pageBlock`, never Tailwind's `block` utility.
  test('the strip is a page section (.pageBlock, not .block)', () => {
    render(<Tabs items={items} />);
    const wrap = screen.getByRole('tablist').parentElement;
    expect(wrap?.classList.contains('pageBlock')).toBe(true);
    expect(wrap?.classList.contains('block')).toBe(false);
  });

  test('a host’s data-* hooks reach the strip’s wrapper', () => {
    render(<Tabs items={items} data-testid="memory-tabs" data-slot="tabs" />);
    const wrap = screen.getByTestId('memory-tabs');
    expect(wrap).toBe(screen.getByRole('tablist').parentElement as HTMLElement);
    expect(wrap.dataset.slot).toBe('tabs');
  });

  test('flush leaves out the page column and the bottom margin', () => {
    const { rerender } = render(
      <Tabs items={items} data-testid="memory-tabs" flush />
    );
    const wrap = screen.getByTestId('memory-tabs');
    expect(wrap.classList.contains('pageBlock')).toBe(false);
    rerender(<Tabs items={items} data-testid="memory-tabs" />);
    expect(wrap.classList.contains('pageBlock')).toBe(true);
    // The bottom margin lives on .wrap only; .flush sets no margin at all.
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'components', 'tabs.module.css'),
      'utf8'
    );
    const flush = /\.flush \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(flush).not.toBe('');
    expect(flush).not.toContain('margin');
    expect(/\.wrap \{[^}]*margin-bottom/.test(css)).toBe(true);
  });

  test('a controlled value selects the named tab; an unknown one the first', () => {
    const { rerender } = render(<Tabs items={items} value="more" />);
    const [first, second] = screen.getAllByRole('tab');
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(first.getAttribute('aria-selected')).toBe('false');
    expect(second.tabIndex).toBe(0);
    expect(screen.getByText('Second panel').hidden).toBe(false);
    expect(screen.getByText('First panel').hidden).toBe(true);

    rerender(<Tabs items={items} value="gone" />);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('First panel').hidden).toBe(false);
  });

  test('controlled, a click or ArrowRight only reports the pick until the host passes it', () => {
    const picks: string[] = [];
    const onChange = (id: string) => picks.push(id);
    const { rerender } = render(
      <Tabs items={items} value="overview" onChange={onChange} />
    );
    const [first, second] = screen.getAllByRole('tab');

    fireEvent.click(second);
    expect(picks).toEqual(['more']);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('false');
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(picks).toEqual(['more', 'more']);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);

    // Picking the selected tab again reports nothing.
    fireEvent.click(first);
    expect(picks).toEqual(['more', 'more']);

    rerender(<Tabs items={items} value="more" onChange={onChange} />);
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(first.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('Second panel').hidden).toBe(false);

    fireEvent.keyDown(second, { key: 'Home' });
    expect(picks).toEqual(['more', 'more', 'overview']);
    expect(document.activeElement).toBe(first);
    expect(second.getAttribute('aria-selected')).toBe('true');
  });

  test('uncontrolled, a pick moves the selection and is reported too', () => {
    const picks: string[] = [];
    render(<Tabs items={items} onChange={(id) => picks.push(id)} />);
    const [first, second] = screen.getAllByRole('tab');

    fireEvent.keyDown(first, { key: 'End' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);
    expect(picks).toEqual(['more']);

    fireEvent.click(first);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('First panel').hidden).toBe(false);
    expect(picks).toEqual(['more', 'overview']);
  });

  test('items without content share the host’s panel, labelled by the selected tab', () => {
    const hosted: TabItem[] = [
      { id: 'entries', label: 'Entries 3' },
      { id: 'proposals', label: 'Proposals' },
      { id: 'about', label: 'About', content: 'Own panel' },
    ];
    function Host({ value }: { value: string }) {
      return (
        <Tabs items={hosted} label="Memory" value={value}>
          <ul aria-label="Memory entries">
            <li>Host list</li>
          </ul>
        </Tabs>
      );
    }
    const { rerender } = render(<Host value="entries" />);
    const [entries, proposals, about] = screen.getAllByRole('tab');
    const list = screen.getByRole('list', { name: 'Memory entries' });

    // One host panel, owned by the selected tab; the unselected tab
    // without content names no panel.
    const hostPanel = document.getElementById(
      entries.getAttribute('aria-controls') ?? ''
    );
    expect(hostPanel?.getAttribute('role')).toBe('tabpanel');
    expect(hostPanel?.getAttribute('aria-labelledby')).toBe(entries.id);
    expect(hostPanel?.contains(list)).toBe(true);
    expect(hostPanel?.hidden).toBe(false);
    expect(proposals.hasAttribute('aria-controls')).toBe(false);
    expect(
      screen.getByRole('tabpanel', { name: 'Entries 3' }).contains(list)
    ).toBe(true);
    // An item with content keeps its own (hidden) panel.
    const own = document.getElementById(
      about.getAttribute('aria-controls') ?? ''
    );
    expect(own?.textContent).toBe('Own panel');
    expect(own?.hidden).toBe(true);

    // Moving between tabs without content keeps the host's list mounted
    // and hands the panel to the newly selected tab.
    rerender(<Host value="proposals" />);
    expect(screen.getByRole('list', { name: 'Memory entries' })).toBe(list);
    expect(entries.hasAttribute('aria-controls')).toBe(false);
    const moved = document.getElementById(
      proposals.getAttribute('aria-controls') ?? ''
    );
    expect(moved?.contains(list)).toBe(true);
    expect(moved?.getAttribute('aria-labelledby')).toBe(proposals.id);

    // A tab with its own content shows it, and the host panel goes.
    rerender(<Host value="about" />);
    expect(own?.hidden).toBe(false);
    expect(screen.queryByRole('list', { name: 'Memory entries' })).toBeNull();
    expect(screen.getAllByRole('tabpanel')).toEqual([own as HTMLElement]);
  });

  test('a controlled strip renders on the server with the chosen tab selected', () => {
    const html = renderToString(
      <Tabs items={items} value="more" onChange={() => undefined} />
    );
    expect(html).toMatch(
      /<button[^>]*role="tab"[^>]*aria-selected="false"[^>]*>Overview<\/button>/
    );
    expect(html).toMatch(
      /<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>More<\/button>/
    );
    expect(html).toMatch(/<div role="tabpanel"[^>]*hidden=""[^>]*>First panel/);
    expect(html).toMatch(
      /<div role="tabpanel"(?![^>]*hidden)[^>]*>Second panel/
    );
  });
});

describe('ThemeToggle', () => {
  function withOsDark(dark: boolean, run: () => void) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      run();
    } finally {
      window.matchMedia = original;
    }
  }

  test('in "system" mode it flips to the opposite of what the OS shows', () => {
    withOsDark(true, () => {
      document.documentElement.dataset.theme = 'system';
      render(<ThemeToggle storageKey="bt-test-theme" />);
      fireEvent.click(screen.getByRole('button'));
      expect(document.documentElement.dataset.theme).toBe('light');
    });
  });

  test('otherwise it flips light and dark', () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle storageKey="bt-test-theme" />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  // Through showTheme, so the colours do not animate (tokens.css).
  test('a flip turns transitions off for the swap', () => {
    const root = document.documentElement;
    root.dataset.theme = 'light';
    try {
      render(<ThemeToggle storageKey="bt-test-theme" />);
      fireEvent.click(screen.getByRole('button'));
      expect(root.dataset.theme).toBe('dark');
      expect(root.hasAttribute('data-theme-switching')).toBe(true);
    } finally {
      root.removeAttribute('data-theme-switching');
    }
  });
});

describe('cx', () => {
  test('is exported from the root and drops empty names', () => {
    expect(cx('row', undefined, false, null, '', 'active')).toBe('row active');
    expect(cx()).toBe('');
    expect(cx(undefined)).toBe('');
  });
});

// Every public component's props are a named, exported type (a host
// wrapping one needs no ComponentProps<typeof …>). Checked by tsc.
export type PublicProps = [
  BlockBarProps,
  ConfirmDialogProps,
  DialogProps,
  PickerMarkViewProps,
  PopoverProps,
  SpinnerProps,
  StatusMarkProps,
  TabsProps,
  ThemeToggleProps,
  TooltipProps,
  UiLinkProviderProps,
];

// DataAttributes takes any data-* key and nothing else (checked by tsc).
export const hostHooks: DataAttributes = {
  'data-testid': 'tasks-back',
  'data-slot': 'settings-panel',
  'data-count': 3,
  'data-open': true,
  'data-gone': undefined,
};
// @ts-expect-error -- a prop that is not data-* is not a host hook
export const notAHook: DataAttributes = { title: 'Back' };
