import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { ShortcutsDialog } from './ShortcutsDialog';

afterEach(cleanup);

test('Two views lists only the places it has', () => {
  render(<ShortcutsDialog open twoViews onOpenChange={() => undefined} />);
  for (const label of ['Overseer', 'Tasks', 'Threads', 'Settings']) {
    expect(screen.getByText(label)).toBeDefined();
  }
  for (const label of [
    'Inbox',
    'Live',
    'Overview',
    'Assistant',
    'Projects',
    'Toggle sidebar',
  ]) {
    expect(screen.queryByText(label)).toBeNull();
  }
  expect(screen.queryByRole('region', { name: 'Home' })).toBeNull();
});

test('Classic keeps its sidebar and views', () => {
  render(<ShortcutsDialog open onOpenChange={() => undefined} />);
  expect(screen.getByText('Inbox')).toBeDefined();
  expect(screen.getByText('Toggle sidebar')).toBeDefined();
});
