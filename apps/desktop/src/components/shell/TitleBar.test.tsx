import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { TitleBar } from './TitleBar';

const props = {
  projectName: 'dispatch',
  projectPath: '/Users/x/dispatch',
  noProjectYet: false,
  switcherOpen: false,
  onToggleSwitcher: () => {},
  switchProjects: [],
  onSelectProject: () => {},
  onAddProject: () => {},
  onOpenPalette: () => {},
  unreadCount: 0,
  inboxOpen: false,
  onToggleInbox: () => {},
  inboxPanel: null,
  drafts: [],
  onOpenDraft: () => {},
  onDismissDraft: () => {},
};

test('shows the active project with its full path as the tooltip', () => {
  render(<TitleBar {...props} />);
  const trigger = screen.getByRole('button', { name: /dispatch/ });
  expect(trigger.getAttribute('title')).toBe('/Users/x/dispatch');
});

test('offers Add project… when resolution settled with no project', () => {
  render(<TitleBar {...props} projectName={null} noProjectYet />);
  expect(screen.getByRole('button', { name: 'Add project…' })).toBeTruthy();
  expect(screen.queryByText('Resolving project…')).toBeNull();
});

test('shows the resolving placeholder before the project settles', () => {
  render(<TitleBar {...props} projectName={null} />);
  expect(screen.getByText('Resolving project…')).toBeTruthy();
});

test('the search pill opens the command palette', () => {
  let opened = 0;
  render(<TitleBar {...props} onOpenPalette={() => opened++} />);
  fireEvent.click(screen.getByRole('button', { name: /Search or jump to/ }));
  expect(opened).toBe(1);
});

test('the bell toggles the inbox and announces the unread count', () => {
  let toggled = 0;
  render(
    <TitleBar {...props} unreadCount={4} onToggleInbox={() => toggled++} />
  );
  const bell = screen.getByRole('button', { name: 'Notifications (4 unread)' });
  fireEvent.click(bell);
  expect(toggled).toBe(1);
});

test('the bell drops the unread suffix and attention dot at zero', () => {
  render(<TitleBar {...props} />);
  const bell = screen.getByRole('button', { name: 'Notifications' });
  expect(bell.querySelector('.bg-primary')).toBeNull();
});
