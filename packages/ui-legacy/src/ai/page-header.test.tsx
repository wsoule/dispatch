import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  HeaderIconTriad,
  PageHeader,
  type PageHeaderShell,
  PageHeaderShellContext,
  ViewTabs,
} from './page-header';

const shell = (over: Partial<PageHeaderShell>): PageHeaderShell => ({
  sidebarHidden: false,
  onToggleSidebar: () => {},
  trafficLightInset: false,
  dragRegion: false,
  ...over,
});

const rows = (container: HTMLElement) =>
  [
    ...container.querySelectorAll('[data-slot="page-header-row"]'),
  ] as HTMLElement[];

test('the crumb joins segments and brightens the last one', () => {
  render(<PageHeader crumb={['Dispatch', 'Tasks']} />);
  const page = screen.getByText('Tasks');
  expect(page.className).toContain('text-foreground');
  expect(page.getAttribute('aria-current')).toBe('page');
  expect(screen.getByText('Dispatch').className).not.toContain(
    'text-foreground'
  );
  expect(screen.getByText('›')).toBeDefined();
});

test('row 2 renders only when tabs or controls are given', () => {
  const { container: one } = render(<PageHeader crumb={['Tasks']} />);
  expect(rows(one)).toHaveLength(1);
  const { container: two } = render(
    <PageHeader crumb={['Tasks']} controls={<button type="button">x</button>} />
  );
  expect(rows(two)).toHaveLength(2);
  // Both rows sit on the 44px grid; the tab row may grow when its pills wrap.
  expect(rows(two)[0]?.className).toContain('h-11');
  expect(rows(two)[1]?.className).toContain('min-h-11');
});

// Outside the shell nothing about the window leaks in: no toggle, no inset, no drag.
test('without the shell context there is no toggle, inset or drag region', () => {
  const { container } = render(<PageHeader crumb={['Tasks']} />);
  expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();
  const row = rows(container)[0];
  expect(row.className).not.toContain('pl-[76px]');
  expect(row.hasAttribute('data-tauri-drag-region')).toBe(false);
});

test('a hidden sidebar adds the show-sidebar button and the traffic-light inset', () => {
  let toggles = 0;
  const { container } = render(
    <PageHeaderShellContext.Provider
      value={shell({
        sidebarHidden: true,
        trafficLightInset: true,
        onToggleSidebar: () => toggles++,
      })}
    >
      <PageHeader crumb={['Tasks']} />
    </PageHeaderShellContext.Provider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
  expect(toggles).toBe(1);
  expect(rows(container)[0].className).toContain('pl-[76px]');
});

test('a visible sidebar shows no toggle and no inset even with traffic lights', () => {
  const { container } = render(
    <PageHeaderShellContext.Provider
      value={shell({ sidebarHidden: false, trafficLightInset: true })}
    >
      <PageHeader crumb={['Tasks']} />
    </PageHeaderShellContext.Provider>
  );
  expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();
  expect(rows(container)[0].className).not.toContain('pl-[76px]');
});

test('dragRegion marks row 1 only', () => {
  const { container } = render(
    <PageHeaderShellContext.Provider value={shell({ dragRegion: true })}>
      <PageHeader crumb={['Tasks']} tabs={<span>tabs</span>} />
    </PageHeaderShellContext.Provider>
  );
  const [first, second] = rows(container);
  expect(first.hasAttribute('data-tauri-drag-region')).toBe(true);
  expect(second.hasAttribute('data-tauri-drag-region')).toBe(false);
});

test('ViewTabs are 28px pills and the active one is lifted', () => {
  let picked = '';
  render(
    <ViewTabs
      tabs={[
        { id: 'board', label: 'Board' },
        { id: 'list', label: 'List' },
      ]}
      active="board"
      onChange={(id) => (picked = id)}
    />
  );
  const board = screen.getByRole('tab', { name: 'Board' });
  const list = screen.getByRole('tab', { name: 'List' });
  expect(board.getAttribute('aria-selected')).toBe('true');
  expect(board.className).toContain('bg-surface-active');
  expect(list.className).toContain('bg-surface-control');
  expect(board.className.split(/\s+/)).toContain('h-7');
  fireEvent.click(list);
  expect(picked).toBe('list');
});

// One tab stop: only the active tab is tabbable and arrows move (and select) with wrap.
test('ViewTabs rove with the arrow keys and wrap at the ends', () => {
  let picked = '';
  render(
    <ViewTabs
      tabs={[
        { id: 'active', label: 'Active' },
        { id: 'backlog', label: 'Backlog' },
        { id: 'all', label: 'All issues' },
      ]}
      active="all"
      onChange={(id) => (picked = id)}
    />
  );
  const all = screen.getByRole('tab', { name: 'All issues' });
  expect(all.tabIndex).toBe(0);
  expect(screen.getByRole('tab', { name: 'Active' }).tabIndex).toBe(-1);
  fireEvent.keyDown(all, { key: 'ArrowRight' });
  expect(picked).toBe('active');
  fireEvent.keyDown(all, { key: 'ArrowLeft' });
  expect(picked).toBe('backlog');
  fireEvent.keyDown(all, { key: 'Home' });
  expect(picked).toBe('active');
  fireEvent.keyDown(all, { key: 'Enter' });
  expect(picked).toBe('active');
});

test('the triad shows a dot only while a filter is active', () => {
  const { container: idle } = render(<HeaderIconTriad />);
  expect(idle.querySelector('[data-slot="filter-active-dot"]')).toBeNull();
  expect(idle.querySelectorAll('button')).toHaveLength(3);
  const { container: active } = render(<HeaderIconTriad filterActive />);
  expect(
    active.querySelector('[data-slot="filter-active-dot"]')
  ).not.toBeNull();
});
