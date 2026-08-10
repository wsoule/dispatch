import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { PROJECT_VIEW_ORDER, Sidebar, useSidebarCollapsed } from './Sidebar';
import { SidebarProvider } from '@/ui/sidebar';

const props = {
  projectName: 'dispatch',
  projectPath: '/Users/x/dispatch',
  hasActiveProject: true,
  section: 'project' as const,
  projectView: 'runs' as const,
  globalView: 'all-agents' as const,
  liveAgentCount: 3,
  badges: { board: 2 },
  spendToday: 1.5,
  unreadCount: 4,
  onToggleInbox: () => {},
  drafts: [],
  onOpenDraft: () => {},
  onDismissDraft: () => {},
  onSetProjectView: () => {},
  onSetGlobalView: () => {},
  switcherOpen: false,
  onToggleSwitcher: () => {},
  switchProjects: [],
  onSelectProject: () => {},
  syncStatus: null,
  onDisableAutoCommit: () => {},
  noProjectYet: false,
  onAddProject: () => {},
};

// The rail only reads its collapsed state from `SidebarProvider`, so every case mounts through
// one — `open={false}` is the icon-only strip.
function mount(open: boolean, overrides: Partial<typeof props> = {}) {
  return render(
    <SidebarProvider open={open} onOpenChange={() => {}}>
      <Sidebar {...props} {...overrides} />
    </SidebarProvider>
  );
}

const RAIL_LABELS = [
  'Overview',
  'Brain dump',
  'Plans',
  'Tasks',
  'Runs',
  'Review',
  'Impact',
  'Git',
];

test('the exported view order is the cmd+N order App.tsx indexes into', () => {
  expect(PROJECT_VIEW_ORDER).toEqual([
    'overview',
    'brain-dump',
    'plans',
    'board',
    'runs',
    'review',
    'impact',
    'branches',
  ]);
});

test('expanded rail shows every row with its shortcut number', () => {
  mount(true);
  // The number counts across stages, not within one — cutting the rail into groups must not
  // restart it at "Plan".
  RAIL_LABELS.forEach((label, index) => {
    const row = screen.getByRole('button', {
      name: new RegExp(`^${label.replace(' ', '.')}.*⌘${index + 1}$`),
    });
    expect(row.getAttribute('data-active')).toBe(String(label === 'Runs'));
  });
  expect(screen.getByText('Workspace')).toBeTruthy();
  expect(screen.getByText('Plan')).toBeTruthy();
  expect(screen.getByText('Work')).toBeTruthy();
  expect(screen.getByText('$1.50')).toBeTruthy();
  expect(screen.getByText('⌘K')).toBeTruthy();
  // Per-row count, unread bell count, live-agent count.
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.getByText('4')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
});

test('collapsed rail hides labels but keeps every accessible name', () => {
  mount(false);
  for (const label of [...RAIL_LABELS, 'All Agents', 'Sessions', 'Settings']) {
    expect(
      screen.getByRole('button', { name: label }).getAttribute('aria-label')
    ).toBe(label);
  }
  expect(
    screen.getByRole('button', { name: 'Notifications (4 unread)' })
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Switch project (current: dispatch)' })
  ).toBeTruthy();
  expect(screen.queryByText('⌘1')).toBeNull();
  expect(screen.queryByText('⌘K')).toBeNull();
  expect(screen.queryByText('Workspace')).toBeNull();
  expect(screen.queryByText('$1.50')).toBeNull();
});

test('the collapse button still announces the rail it controls', () => {
  const { unmount } = mount(true);
  const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
  expect(collapse.getAttribute('aria-expanded')).toBe('true');
  expect(collapse.getAttribute('aria-controls')).toBe('dispatch-sidebar');
  expect(document.getElementById('dispatch-sidebar')).toBeTruthy();
  unmount();

  mount(false);
  expect(
    screen
      .getByRole('button', { name: 'Expand sidebar' })
      .getAttribute('aria-expanded')
  ).toBe('false');
});

// The key and its '1'/'0' encoding are a stored-state contract with every install that already
// has a preference written — a rename or a re-encoding silently expands everyone's rail once.
test('the collapsed preference round-trips through its long-standing key', () => {
  function Probe() {
    const [collapsed, setCollapsed] = useSidebarCollapsed();
    return (
      <button type="button" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? 'collapsed' : 'expanded'}
      </button>
    );
  }

  window.localStorage.removeItem('dispatch:sidebar-collapsed');
  const first = render(<Probe />);
  expect(window.localStorage.getItem('dispatch:sidebar-collapsed')).toBe('0');
  fireEvent.click(screen.getByRole('button'));
  expect(window.localStorage.getItem('dispatch:sidebar-collapsed')).toBe('1');
  first.unmount();

  render(<Probe />);
  expect(screen.getByRole('button').textContent).toBe('collapsed');
  window.localStorage.removeItem('dispatch:sidebar-collapsed');
});

test('project rows are disabled until a project resolves', () => {
  mount(true, { hasActiveProject: false });
  const row = screen.getByRole('button', { name: /^Overview/ });
  expect((row as HTMLButtonElement).disabled).toBe(true);
});
