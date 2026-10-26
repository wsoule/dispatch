import type { ShellSection } from '@dispatch/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { type ReactNode, useState } from 'react';

import type { NavAction } from '../../lib/appNav';
import { FirstTaskGuide } from '../guide/FirstTaskGuide';
import { PeopleProvider } from '../people/PeopleContext';
import { DispatchShell, type DispatchShellProps } from './DispatchShell';

const PROJECTS: ShellSection = {
  id: 'projects',
  title: 'Projects',
  emptyLabel: 'No projects yet',
  action: { label: 'All', href: '#/projects' },
  items: [
    {
      id: 'p-1',
      label: 'Checkout',
      href: '#/task/p-1',
      status: 'at_risk',
      statusLabel: 'Needs attention',
    },
  ],
};

interface Harness {
  actions: NavAction[];
  calls: string[];
}

function shell(over: Partial<DispatchShellProps> = {}): {
  element: ReactNode;
  log: Harness;
} {
  const log: Harness = { actions: [], calls: [] };
  const element = (
    <PeopleProvider
      people={[{ ref: 'human:ada', name: 'Ada Lovelace' }]}
      me="human:ada"
    >
      <DispatchShell
        projectName="storefront"
        view="overseer"
        destination="overseer"
        taskTitle={null}
        overseerBadge={{
          count: 2,
          tone: 'amber',
          label: 'Overseer · 2 waiting on you (work 2)',
        }}
        needsYou={2}
        threadsUnread={3}
        adminItems={[]}
        projects={PROJECTS}
        tier="operator"
        onNavigate={(action) => log.actions.push(action)}
        onSearch={() => log.calls.push('search')}
        gate={null}
        overseer={<p>overseer</p>}
        tasks={<p>tasks</p>}
        peek={null}
        {...over}
      />
    </PeopleProvider>
  );
  return { element, log };
}

function primaryNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Primary' });
}

describe('DispatchShell', () => {
  test('the sidebar lists the destinations, the current one marked, with the counts', () => {
    render(shell().element);
    expect(screen.getByTestId('dispatch-shell')).toBeTruthy();
    const nav = primaryNav();
    // The phone tab bar repeats four of these; the nav landmark is the list.
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'))
    ).toEqual([
      '#/overseer',
      '#/issues',
      '#/needs-you',
      '#/timeline',
      '#/graph',
      '#/threads',
      '#/docs',
      '#/runs',
    ]);
    expect(
      nav.querySelector('[aria-current="page"]')?.getAttribute('href')
    ).toBe('#/overseer');
    // The orb's amber on the Overseer count, amber asks, accent unread.
    const overseer = screen.getByRole('link', {
      name: /^Overseer ?, Overseer · 2 waiting on you/,
    });
    expect(
      overseer.querySelector('[data-tone]')?.getAttribute('data-tone')
    ).toBe('warning');
    // How a hidden span is spaced before the comma is the DOM's business.
    const needs = screen.getByRole('link', {
      name: /^Needs you ?, 2 waiting on you$/,
    });
    expect(needs.getAttribute('href')).toBe('#/needs-you');
    expect(
      screen.getByRole('link', { name: /^Threads ?, 3 unread$/ })
    ).toBeTruthy();
    // The project row, its status in its name, and the footer's Settings link.
    const project = screen.getByRole('link', {
      name: 'Checkout, Needs attention',
    });
    expect(project.getAttribute('href')).toBe('#/task/p-1');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    // The brand row names the app and the project; the crumb starts with the project.
    expect(
      screen.getByRole('link', { name: 'Dispatch storefront' })
    ).toBeTruthy();
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent
    ).toBe('storefront/Overseer');
    // The signed-in person, named from the registry, with their tier.
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Operator')).toBeTruthy();
    // No sign-out outside team-local mode.
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
  });

  test('a plain click on a row dispatches what its href parses to and stays in the app', () => {
    const { element, log } = shell();
    render(element);
    const issues = within(primaryNav()).getByRole('link', { name: 'Issues' });
    const click = fireEvent.click(issues);
    expect(click).toBe(false);
    expect(log.actions).toEqual([{ type: 'showTasks' }]);
    fireEvent.click(
      screen.getByRole('link', { name: /^Threads ?, 3 unread$/ })
    );
    expect(log.actions[1]).toEqual({ type: 'setProjectView', view: 'threads' });
    fireEvent.click(screen.getByRole('link', { name: 'Runs' }));
    expect(log.actions[2]).toEqual({ type: 'openSettings', page: 'runs' });
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(log.actions[3]).toEqual({ type: 'openSettings' });
    fireEvent.click(within(primaryNav()).getByRole('link', { name: 'Graph' }));
    expect(log.actions[4]).toEqual({
      type: 'openGraph',
      scope: { level: 'milestone' },
      nodeId: null,
    });
    fireEvent.click(
      within(primaryNav()).getByRole('link', { name: /^Timeline/ })
    );
    expect(log.actions[5]).toEqual({ type: 'openTimeline', project: null });
    // A project row opens its page; "All" opens the Projects page under Tasks.
    fireEvent.click(
      screen.getByRole('link', { name: 'Checkout, Needs attention' })
    );
    expect(log.actions[6]).toEqual({ type: 'openTask', taskId: 'p-1' });
    fireEvent.click(screen.getByRole('link', { name: 'All Projects' }));
    expect(log.actions[7]).toEqual({
      type: 'setProjectView',
      view: 'projects',
    });
    // The brand row is the Overseer.
    fireEvent.click(screen.getByRole('link', { name: 'Dispatch storefront' }));
    expect(log.actions[8]).toEqual({ type: 'showOverseer' });
    expect(log.calls).toEqual([]);
  });

  test('a link with parameters dispatches every action its route holds', () => {
    const { element, log } = shell({
      projects: {
        ...PROJECTS,
        items: [
          {
            id: 'p-1',
            label: 'Checkout',
            href: '#/timeline?project=p-1',
            status: 'on_track',
            statusLabel: 'On track',
            current: true,
          },
        ],
      },
    });
    render(element);
    const row = screen.getByRole('link', { name: 'Checkout, On track' });
    expect(row.getAttribute('aria-current')).toBe('page');
    fireEvent.click(row);
    expect(log.actions).toEqual([{ type: 'openTimeline', project: 'p-1' }]);
  });

  test('modified and middle clicks are left to the browser', () => {
    const { element, log } = shell();
    render(element);
    const issues = within(primaryNav()).getByRole('link', { name: 'Issues' });
    expect(fireEvent.click(issues, { metaKey: true })).toBe(true);
    expect(fireEvent.click(issues, { button: 1 })).toBe(true);
    expect(fireEvent.click(issues, { shiftKey: true })).toBe(true);
    expect(log.actions).toEqual([]);
    // The skip link is not a destination: the browser follows it.
    expect(
      fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }))
    ).toBe(true);
  });

  test('the search trigger opens the palette; the views swap with the view prop', () => {
    const { element, log } = shell({ view: 'tasks', destination: 'issues' });
    const { container } = render(element);
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(log.calls).toEqual(['search']);
    expect(
      primaryNav().querySelector('[aria-current="page"]')?.getAttribute('href')
    ).toBe('#/issues');
    // Both views stay mounted; the hidden one is an Activity boundary.
    expect(container.textContent).toContain('tasks');
    expect(container.querySelector('main')?.id).toBe('dispatch-main');
  });

  test('a team-local session gets a sign-out button naming the handle', () => {
    const calls: string[] = [];
    render(
      shell({
        teamSession: { handle: 'grace', onSignOut: () => calls.push('out') },
      }).element
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out grace' }));
    expect(calls).toEqual(['out']);
  });

  test('a Tauri window gets the drag region and the traffic-light inset', () => {
    render(
      shell({
        windowChrome: { dragRegion: true, trafficLightInset: true },
      }).element
    );
    expect(document.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(
      2
    );
    expect(
      screen
        .getByTestId('dispatch-shell')
        .style.getPropertyValue('--shell-brand-inset')
    ).toBe('68px');
  });

  test('the guide floats over the views and gives way to a gate screen', () => {
    const { rerender } = render(shell({ guide: <p>guide card</p> }).element);
    expect(screen.getByTestId('first-task-guide-slot').textContent).toBe(
      'guide card'
    );
    rerender(shell({ guide: <p>guide card</p>, gate: <p>setup</p> }).element);
    expect(screen.queryByTestId('first-task-guide-slot')).toBeNull();
    expect(screen.getByText('setup')).toBeTruthy();
  });

  test('the guide steps aside while a peek drawer is open', () => {
    const { rerender } = render(
      shell({ guide: <p>guide card</p>, peek: <aside>peek</aside> }).element
    );
    expect(screen.queryByTestId('first-task-guide-slot')).toBeNull();
    rerender(shell({ guide: <p>guide card</p> }).element);
    expect(screen.getByTestId('first-task-guide-slot')).toBeTruthy();
  });
});

// Fakes the content area's measured width, since the test DOM has no layout.
const realWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth'
);
function mainWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => px,
  });
}
afterEach(() => {
  if (realWidth !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', realWidth);
  }
});

// A guide card whose expand/collapse choice lives in state, like the app's hook.
function GuideHarness() {
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const noop = () => {};
  const card = (
    <FirstTaskGuide
      view={{ stage: 'describe' }}
      provider={null}
      sendOptions={{ modelChoice: false }}
      sendError={null}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      actions={{
        showDescribe: noop,
        openDraft: noop,
        openTask: noop,
        send: () => Promise.resolve(),
        retryDraft: () => Promise.resolve(),
        retryRun: () => Promise.resolve(),
        askAgentToFix: () => Promise.resolve(),
        looksGood: noop,
        askForChanges: () => Promise.resolve(),
        land: () => Promise.resolve(),
        startOver: () => Promise.resolve(),
        dismiss: noop,
        closeCompletion: noop,
        openBoard: noop,
        openOverseer: noop,
        inviteTeammate: noop,
      }}
    />
  );
  return shell({ guide: card }).element;
}

test('the guide starts collapsed when the main area is narrow, and stays open once expanded', () => {
  mainWidth(640);
  render(<GuideHarness />);
  expect(screen.getByText(/^Your first task · Step 1/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Expand the guide' }));
  expect(
    screen.getByRole('button', { name: 'Collapse the guide' })
  ).toBeTruthy();
  expect(screen.queryByText(/^Your first task · Step/)).toBeNull();
});

test('the guide starts expanded when the main area is wide', () => {
  mainWidth(1280);
  render(<GuideHarness />);
  expect(
    screen.getByRole('button', { name: 'Collapse the guide' })
  ).toBeTruthy();
});
