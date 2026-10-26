// cspell:ignore Focusthe -- textContent concatenations asserted below
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';

import {
  type BlockBarProps,
  GraphLegend,
  type PickerMarkViewProps,
  type StatusMarkProps,
  type TabItem,
  Tabs,
  type TabsProps,
  ThemeToggle,
  type ThemeToggleProps,
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
});

describe('GraphLegend focus swatch', () => {
  test('node-focus draws in the Nodes row with its name and note', () => {
    render(
      <GraphLegend
        label="Chain legend"
        items={[
          { mark: 'node', label: 'Issue' },
          {
            mark: 'node-focus',
            label: 'Focus',
            note: 'the issue this chain is about',
          },
          { mark: 'edge-risk', label: 'Risk chain' },
        ]}
      />
    );
    const legend = screen.getByRole('group', { name: 'Chain legend' });
    const [nodes, edges] = within(legend).getAllByRole('list');
    const item = within(nodes)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Focus'));
    expect(item?.textContent).toBe('Focusthe issue this chain is about');
    const swatch = item?.querySelector('[data-mark]');
    expect(swatch?.getAttribute('data-mark')).toBe('node-focus');
    expect(swatch?.getAttribute('aria-hidden')).toBe('true');
    expect(edges.querySelector('[data-mark="node-focus"]')).toBeNull();
  });

  test('the swatch repeats the graph’s accent ring standing off the box', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'graph',
        'graph-legend.module.css'
      ),
      'utf8'
    );
    const rule = /\.nodeFocus::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('inset: -4px;');
    expect(rule).toContain('border: 2px solid var(--accent);');
  });
});

// Every public component's props are a named, exported type (a host
// wrapping one needs no ComponentProps<typeof …>). Checked by tsc.
export type PublicProps = [
  BlockBarProps,
  PickerMarkViewProps,
  StatusMarkProps,
  TabsProps,
  ThemeToggleProps,
  UiLinkProviderProps,
];
