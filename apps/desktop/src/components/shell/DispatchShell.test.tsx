import { Link, type ShellSection } from '@dispatch/ui';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { NavAction } from '../../lib/appNav';
import { FirstTaskGuide } from '../guide/FirstTaskGuide';
import { PeopleProvider } from '../people/PeopleContext';
import {
  DispatchShell,
  type DispatchShellProps,
  useNarrowMain,
} from './DispatchShell';
import { projectWorkspaceSwitcher } from './projectWorkspaces';

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

  // With a switcher the brand row is a menu of the projects, not a link to
  // the Overseer (the sidebar's Overseer row still is).
  test('with a switcher the brand row switches project and adds one', async () => {
    const switched: string[] = [];
    const added: string[] = [];
    const opened: boolean[] = [];
    const { element, log } = shell({
      workspaceSwitcher: projectWorkspaceSwitcher({
        active: { name: 'storefront', path: '/Users/ada/storefront' },
        projects: [
          { name: 'billing', path: '/Users/ada/code/billing' },
          { name: 'storefront', path: '/Users/ada/storefront' },
        ],
        onSelectProject: (path) => switched.push(path),
        onAddProject: () => added.push('add'),
        onOpenChange: (open) => opened.push(open),
      }),
    });
    render(element);
    expect(
      screen.queryByRole('link', { name: 'Dispatch storefront' })
    ).toBeNull();
    const brand = screen.getByRole('button', {
      name: 'Dispatch storefront, switch project',
    });
    fireEvent.click(brand);
    expect(opened).toEqual([true]);
    const list = screen.getByRole('listbox', { name: 'Project' });
    const rows = within(list)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('billing');
    expect(rows[0]).toContain('~/code/billing');
    expect(rows[1]).toContain('storefront');
    expect(rows[1]).toContain('~/storefront');
    expect(rows[2]).toContain('Add project…');
    fireEvent.click(within(list).getByRole('option', { name: /billing/ }));
    expect(switched).toEqual(['/Users/ada/code/billing']);
    // The picker settles its save contract (onSwitch returned nothing).
    await act(async () => {});
    // Adding a project runs in place: the menu closes, then the host's
    // dialog opens; nothing switches.
    fireEvent.click(brand);
    fireEvent.click(screen.getByRole('option', { name: 'Add project…' }));
    expect(added).toEqual(['add']);
    expect(switched).toEqual(['/Users/ada/code/billing']);
    expect(screen.queryByRole('listbox', { name: 'Project' })).toBeNull();
    expect(log.actions).toEqual([]);
    // The Overseer is still a sidebar row.
    expect(
      within(primaryNav())
        .getAllByRole('link')
        .some((link) => link.getAttribute('href') === '#/overseer')
    ).toBe(true);
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

  test('the sidebar footer has the theme toggle, which flips html[data-theme] and stores it', () => {
    const root = document.documentElement;
    root.dataset.theme = 'light';
    try {
      render(shell().element);
      const toggle = screen.getByRole('button', {
        name: 'Switch between light and dark',
      });
      // In the sidebar's footer, beside the person, not in the topbar.
      expect(toggle.closest('aside')).not.toBeNull();
      expect(toggle.closest('[data-tip="Switch theme"]')).not.toBeNull();
      fireEvent.click(toggle);
      expect(root.dataset.theme).toBe('dark');
      expect(localStorage.getItem('dispatch:theme')).toBe('dark');
      fireEvent.click(toggle);
      expect(root.dataset.theme).toBe('light');
      expect(localStorage.getItem('dispatch:theme')).toBe('light');
    } finally {
      delete root.dataset.theme;
      localStorage.removeItem('dispatch:theme');
    }
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

  // Settings is an overlay place in the main column: the views stay mounted
  // beneath it under hidden Activity boundaries, so their state is kept.
  test('Settings takes the main column with both views hidden beneath it', () => {
    const { rerender } = render(
      shell({
        view: 'tasks',
        destination: 'settings',
        settings: <section data-testid="settings-panel">settings page</section>,
        settingsPage: 'agents',
      }).element
    );
    expect(screen.getByTestId('settings-panel').textContent).toBe(
      'settings page'
    );
    // Hidden Activity children stay in the DOM with display: none.
    const overseer = screen.getByText('overseer');
    const tasks = screen.getByText('tasks');
    expect(overseer.style.display).toBe('none');
    expect(tasks.style.display).toBe('none');
    // The crumbs name the place, since the page has no header row of its own.
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent
    ).toBe('storefront/Settings/Agents');
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
        .getByRole('link', { name: 'Settings' })
        .getAttribute('href')
    ).toBe('#/settings');
    // Closing it shows the view it opened over again.
    rerender(shell({ view: 'tasks', destination: 'issues' }).element);
    expect(screen.queryByTestId('settings-panel')).toBeNull();
    expect(screen.getByText('tasks').style.display).not.toBe('none');
    expect(screen.getByText('overseer').style.display).toBe('none');
  });

  test('the peek stays mounted, hidden, under Settings and comes back as it was; the guide steps aside', () => {
    const { rerender } = render(
      shell({
        destination: 'settings',
        settings: <p>settings page</p>,
        settingsPage: 'general',
        peek: <aside>peek</aside>,
        guide: <p>guide card</p>,
      }).element
    );
    expect(screen.getByText('peek').style.display).toBe('none');
    expect(screen.queryByTestId('first-task-guide-slot')).toBeNull();
    rerender(shell({ peek: <aside>peek</aside> }).element);
    expect(screen.getByText('peek').style.display).not.toBe('none');
    rerender(shell({ guide: <p>guide card</p> }).element);
    expect(screen.getByTestId('first-task-guide-slot')).toBeTruthy();
  });

  // The old panel floated over the peek; the peek's own state (a half-typed
  // reply, its tab) must survive Settings opening and closing over it.
  test('a peek keeps its local state while Settings shows over it', () => {
    const settingsOver = (open: boolean) =>
      shell({
        destination: open ? 'settings' : 'overseer',
        settings: open ? <p>settings page</p> : null,
        settingsPage: open ? 'general' : null,
        peek: <DraftPeek />,
      }).element;
    const { rerender } = render(settingsOver(false));
    fireEvent.change(screen.getByLabelText('Reply'), {
      target: { value: 'half typed' },
    });
    rerender(settingsOver(true));
    rerender(settingsOver(false));
    expect(screen.getByLabelText<HTMLInputElement>('Reply').value).toBe(
      'half typed'
    );
  });

  // The old panel floated over any gate: a first-run person can still reach
  // Settings > Agents from the agent setup screen.
  test('Settings shows over a gate, which stays mounted beneath it', () => {
    const { rerender } = render(
      shell({
        gate: <p>agent setup</p>,
        destination: 'settings',
        settings: <section data-testid="settings-panel">settings page</section>,
        settingsPage: 'agents',
      }).element
    );
    expect(screen.getByTestId('settings-panel')).toBeTruthy();
    expect(screen.getByText('agent setup').style.display).toBe('none');
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent
    ).toBe('storefront/Settings/Agents');
    rerender(shell({ gate: <p>agent setup</p> }).element);
    expect(screen.queryByTestId('settings-panel')).toBeNull();
    expect(screen.getByText('agent setup').style.display).not.toBe('none');
  });

  // From the old Settings dialog: focus moves in when it opens (the region is
  // named, so a screen reader says where focus went) and back out on close.
  test('opening Settings moves focus into it, and closing gives focus back to the opener', () => {
    const at = (open: boolean) =>
      shell({
        view: 'tasks',
        destination: open ? 'settings' : 'issues',
        tasks: <button type="button">Row in the list</button>,
        settings: open ? (
          <button type="button">A Settings control</button>
        ) : null,
        settingsPage: open ? 'general' : null,
      }).element;
    const { rerender } = render(at(false));
    const opener = screen.getByRole('button', { name: 'Row in the list' });
    opener.focus();
    rerender(at(true));
    const region = screen.getByRole('region', { name: 'Settings' });
    expect(document.activeElement).toBe(region);
    // Focus moved on inside Settings stays there across a rerender.
    screen.getByRole('button', { name: 'A Settings control' }).focus();
    rerender(at(true));
    expect(document.activeElement?.textContent).toBe('A Settings control');
    // Closing unmounts the page with focus in it: focus returns to the row.
    rerender(at(false));
    expect(document.activeElement).toBe(opener);
  });

  // display: none drops a box's scroll offset in a real browser, so a list
  // hidden under Settings would come back at the top without the shell.
  test('a view scrolled before Settings opened gets its scroll position back', () => {
    const at = (open: boolean) =>
      shell({
        view: 'tasks',
        destination: open ? 'settings' : 'issues',
        tasks: <div data-testid="list">rows</div>,
        settings: open ? <p>settings page</p> : null,
        settingsPage: open ? 'general' : null,
      }).element;
    const { rerender } = render(at(false));
    const list = screen.getByTestId('list');
    list.scrollTop = 240;
    fireEvent.scroll(list);
    rerender(at(true));
    // What the browser does to a box under display: none.
    list.scrollTop = 0;
    rerender(at(false));
    expect(list.scrollTop).toBe(240);
  });

  // A peek's dialog focus (useDialogFocus) hands focus back to its opener in
  // a passive cleanup when Settings hides it; Settings still ends with focus.
  test('Settings opened over a peek ends with focus in Settings', () => {
    const at = (open: boolean) =>
      shell({
        destination: open ? 'settings' : 'overseer',
        topbarActions: <button type="button">Topbar action</button>,
        peek: <FocusReturningPeek />,
        settings: open ? <p>settings page</p> : null,
        settingsPage: open ? 'general' : null,
      }).element;
    const { rerender } = render(at(false));
    expect(document.activeElement?.textContent).toBe('Inside the peek');
    rerender(at(true));
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Settings' })
    );
    // Closing brings the peek back, and its own focus move stands.
    rerender(at(false));
    expect(document.activeElement?.textContent).toBe('Inside the peek');
  });

  test('a page switch that drops focus brings it back to the Settings region', () => {
    const page = (settingsPage: 'general' | 'agents') =>
      shell({
        destination: 'settings',
        settings: (
          <button type="button" key={settingsPage}>
            {settingsPage}
          </button>
        ),
        settingsPage,
      }).element;
    const { rerender } = render(page('general'));
    screen.getByRole('button', { name: 'general' }).focus();
    rerender(page('agents'));
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Settings' })
    );
  });

  test('closing Settings leaves focus a person moved elsewhere, and falls back to the main column', () => {
    const at = (open: boolean, tasks: ReactNode = <p>tasks</p>) =>
      shell({
        view: 'tasks',
        destination: open ? 'settings' : 'issues',
        tasks,
        settings: open ? <p>settings page</p> : null,
        settingsPage: open ? 'general' : null,
      }).element;
    // A sidebar link focused while Settings shows keeps focus when it closes.
    const { rerender, unmount } = render(at(true));
    const sidebarLink = within(primaryNav()).getByRole('link', {
      name: /^Issues/,
    });
    sidebarLink.focus();
    rerender(at(false));
    expect(document.activeElement).toBe(sidebarLink);
    unmount();
    // No opener left to go back to: the main column takes focus.
    const again = render(at(false, <button type="button">Gone soon</button>));
    screen.getByRole('button', { name: 'Gone soon' }).focus();
    // Opening swaps the button out of the list, so the opener is gone.
    again.rerender(at(true));
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Settings' })
    );
    again.rerender(at(false));
    expect(document.activeElement?.id).toBe('dispatch-main');
  });

  test('a page that throws inside Settings is caught by its own boundary', () => {
    function Broken(): ReactNode {
      throw new Error('boom');
    }
    const quiet = console.error;
    console.error = () => {};
    try {
      render(
        shell({
          destination: 'settings',
          settings: <Broken />,
          settingsPage: 'general',
        }).element
      );
    } finally {
      console.error = quiet;
    }
    expect(
      screen.getByText("Dispatch couldn't display Settings.")
    ).toBeTruthy();
    // The sidebar is still there to leave by.
    expect(primaryNav()).toBeTruthy();
  });

  test('a link inside Settings follows through the shell like any other', () => {
    const { element, log } = shell({
      destination: 'settings',
      settings: <ShellLinkProbe href="#/settings/integrations" />,
      settingsPage: 'general',
    });
    render(element);
    fireEvent.click(screen.getByRole('link', { name: 'Linear settings' }));
    expect(log.actions).toEqual([
      { type: 'openSettings', page: 'integrations' },
    ]);
  });
});

// A peek that takes focus when it shows and hands it back to an element
// outside (the topbar's action) when it stops showing, as a dialog does.
function FocusReturningPeek() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    return () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Topbar action')
        ?.focus();
    };
  }, []);
  return (
    <aside>
      <button ref={ref} type="button">
        Inside the peek
      </button>
    </aside>
  );
}

// A peek with a field of its own, standing in for a thread peek's reply box.
function DraftPeek() {
  const [draft, setDraft] = useState('');
  return (
    <aside>
      <label>
        Reply
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    </aside>
  );
}

// A link rendered through the shell's UiLinkProvider, as Settings' own links are.
function ShellLinkProbe({ href }: { href: string }) {
  return <Link href={href}>Linear settings</Link>;
}

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

// Reports the shell's narrow answer as text, where a view would read it.
function NarrowProbe() {
  return <p data-testid="narrow">{useNarrowMain() ? 'narrow' : 'wide'}</p>;
}

// A ResizeObserver stand-in that records what each observer watches, so a
// test can fire the one on a given element; happy-dom never lays out, so its
// own observers never call back.
interface FakeObserver {
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnected: boolean;
}
function installFakeResizeObserver(): {
  observers: FakeObserver[];
  restore: () => void;
} {
  const real = globalThis.ResizeObserver;
  const observers: FakeObserver[] = [];
  class Fake {
    private readonly record: FakeObserver;
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element) {
      this.record.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.record.disconnected = true;
    }
  }
  globalThis.ResizeObserver = Fake as unknown as typeof ResizeObserver;
  return {
    observers,
    restore: () => {
      globalThis.ResizeObserver = real;
    },
  };
}

test('the narrow answer follows the main area as it resizes, and holds while it has no width', () => {
  const fake = installFakeResizeObserver();
  try {
    mainWidth(1280);
    const view = render(shell({ overseer: <NarrowProbe /> }).element);
    const probe = screen.getByTestId('narrow');
    expect(probe.textContent).toBe('wide');
    // The observer on the closest observed box around the view: the
    // shell's content area.
    const watching = fake.observers.filter((o) =>
      o.targets.some((t) => t.contains(probe))
    );
    const content = watching
      .flatMap((o) => o.targets.map((target) => ({ o, target })))
      .filter(({ target }) => target.contains(probe))
      .sort((a, b) => (a.target.contains(b.target) ? 1 : -1))[0];
    if (content === undefined) throw new Error('no observer on the content');
    const resize = (px: number) => {
      mainWidth(px);
      act(() => content.o.callback([], content.o as unknown as ResizeObserver));
    };
    resize(1023);
    expect(probe.textContent).toBe('narrow');
    resize(1024);
    expect(probe.textContent).toBe('wide');
    resize(700);
    expect(probe.textContent).toBe('narrow');
    // A box with no width (not laid out) keeps the last answer.
    resize(0);
    expect(probe.textContent).toBe('narrow');
    view.unmount();
    expect(content.o.disconnected).toBe(true);
  } finally {
    fake.restore();
  }
});
