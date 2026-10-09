import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { ShortcutsDialog } from './ShortcutsDialog';

afterEach(cleanup);

test('lists only the places the app has', () => {
  render(<ShortcutsDialog open onOpenChange={() => undefined} />);
  for (const label of [
    'Overseer',
    'Tasks',
    'Needs you',
    'Moving',
    'Review',
    'Threads',
    'Settings',
  ]) {
    expect(screen.getByText(label)).toBeDefined();
  }
  for (const label of [
    'Inbox',
    'Overview',
    'Assistant',
    'Projects',
    'Toggle sidebar',
  ]) {
    expect(screen.queryByText(label)).toBeNull();
  }
  expect(screen.queryByRole('region', { name: 'Home' })).toBeNull();
});

test("lists the Live graph's keys, since Tasks' graph hosts it", () => {
  render(<ShortcutsDialog open onOpenChange={() => undefined} />);
  expect(screen.getByRole('region', { name: 'Live' })).toBeDefined();
  expect(screen.getByText('Next / previous band')).toBeDefined();
});
