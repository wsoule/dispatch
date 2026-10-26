import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CalendarCheck, ChartGantt } from 'lucide-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import AppShell, { toggleShellCollapsed } from '../src/shell/app-shell';
import { CommandPaletteProvider } from '../src/shell/command-palette';
import type { AppShellProps } from '../src/shell/types';

const KEY = 'test-shell-collapsed';

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

const PROPS: AppShellProps = {
  appName: 'Milestone Planner',
  workspaceName: 'Acme',
  brandHref: '/week',
  nav: [
    {
      id: 'week',
      label: 'My week',
      href: '/week',
      icon: CalendarCheck,
      count: 4,
      countLabel: '4 issues this week',
      current: true,
    },
    {
      id: 'timeline',
      label: 'Timeline',
      href: '/timeline',
      icon: <ChartGantt />,
    },
  ],
  sections: [
    {
      id: 'projects',
      title: 'Projects',
      action: { label: 'All', href: '/projects' },
      items: [
        {
          id: 'atlas',
          label: 'Atlas migration',
          href: '/timeline?project=atlas',
          status: 'overdue',
          statusLabel: 'Overdue',
        },
        {
          id: 'beacon',
          label: 'Beacon search',
          href: '/timeline?project=beacon',
          status: 'on_track',
          statusLabel: 'On track',
        },
      ],
    },
  ],
  settings: { href: '/settings' },
  user: { name: 'Pat Lee', badge: 'Guest' },
  signOut: { action: '/api/auth/logout', method: 'post' },
  crumbs: [
    { label: 'Timeline', href: '/timeline' },
    { label: 'Atlas migration' },
  ],
  storageKey: KEY,
};

function collapseButton(): HTMLElement {
  return screen.getByRole('button', { name: /sidebar/ });
}

describe('AppShell', () => {
  test('a status-toned count is the square chip in its hue', () => {
    const nav = [
      ...PROPS.nav,
      {
        id: 'projects',
        label: 'Projects',
        href: '/projects',
        icon: CalendarCheck,
        count: 2,
        countLabel: '2 projects blocked',
        countTone: 'warning' as const,
      },
    ];
    render(
      <AppShell {...PROPS} nav={nav}>
        Body
      </AppShell>
    );
    const link = screen.getByRole('link', { name: /2 projects blocked/ });
    const count = link.querySelector('[data-tone]');
    expect(count?.getAttribute('data-tone')).toBe('warning');
    expect(count?.textContent).toContain('2');
    // A plain count carries no tone.
    const week = screen.getByRole('link', { name: /4 issues this week/ });
    expect(week.querySelector('[data-tone]')).toBeNull();
  });

  test('renders the frame with the current page marked', () => {
    render(<AppShell {...PROPS}>Body</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain('My week');
    expect(current?.textContent).toContain('4 issues this week');
    // Project rows are quiet (a grey folder tile): the status mark shows
    // only when the milestone needs attention, but every row's status is
    // in its name, one explicit name with the visible name first, so no
    // stray space or missing comma depends on a hidden span.
    const atlas = screen.getByRole('link', {
      name: 'Atlas migration, Overdue',
    });
    expect(atlas.getAttribute('aria-label')).toBe('Atlas migration, Overdue');
    const mark = atlas.querySelector('[role="img"]');
    expect(mark?.getAttribute('data-status')).toBe('overdue');
    // The mark is decoration beside the name, not read a second time.
    expect(mark?.closest('[aria-hidden="true"]')).not.toBeNull();
    const beacon = screen.getByRole('link', {
      name: 'Beacon search, On track',
    });
    expect(beacon.querySelector('[role="img"]')).toBeNull();
    expect(beacon.querySelector('.srOnly')).toBeNull();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Atlas migration'
    );
    expect(screen.getByRole('main').textContent).toBe('Body');
  });

  test('Gr8r chrome: brand row, toned count badges, "/" crumbs, no marks', () => {
    const { container } = render(
      <AppShell
        {...PROPS}
        nav={[
          ...PROPS.nav,
          {
            id: 'projects',
            label: 'Projects',
            href: '/projects',
            icon: CalendarCheck,
            count: 2,
            countLabel: '2 projects blocked',
            countTone: 'warning',
          },
        ]}
      />
    );
    // The brand link keeps its name (main's "<app> <workspace>") when the
    // rail hides the words.
    expect(
      screen.getByRole('link', { name: 'Milestone Planner Acme' })
    ).toBeTruthy();
    // A plain count is a quiet number; a toned one is a badge in its tone.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const week = screen.getByRole('link', { name: /My week/ });
    expect(week.querySelector('[data-tone]')).toBeNull();
    const projects = screen.getByRole('link', { name: /2 projects blocked/ });
    expect(
      projects.querySelector('[data-tone]')?.getAttribute('data-tone')
    ).toBe('warning');
    expect(nav.textContent).not.toMatch(/[A-Z]{4,}/);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.textContent).toBe('Timeline/Atlas migration');
    // The badge is sentence case, as given.
    expect(screen.getByText('Guest')).toBeTruthy();
    // No decorative registration marks (childless hidden spans) are left
    // in the sidebar.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const marks = [
      ...sidebar.querySelectorAll('span[aria-hidden="true"]'),
    ].filter((span) => span.childNodes.length === 0);
    expect(marks).toHaveLength(0);
    expect(container.querySelector('main')).toBeTruthy();
  });

  test('sign out is a real form post', () => {
    render(<AppShell {...PROPS} />);
    const button = screen.getByRole('button', { name: 'Sign out' });
    const form = button.closest('form');
    expect(form?.getAttribute('action')).toBe('/api/auth/logout');
    expect(form?.getAttribute('method')).toBe('post');
    expect(button.getAttribute('type')).toBe('submit');
    expect(form?.querySelectorAll('input')).toHaveLength(0);
  });

  test('sign out can name itself and post hidden fields (one of several workspaces)', () => {
    render(
      <AppShell
        {...PROPS}
        signOut={{
          action: '/api/auth/logout',
          method: 'post',
          label: 'Sign out of Acme',
          fields: { scope: 'current', workspace: 'org-acme' },
        }}
      />
    );
    const button = screen.getByRole('button', { name: 'Sign out of Acme' });
    const inputs = [
      ...(button.closest('form')?.querySelectorAll('input') ?? []),
    ];
    expect(
      inputs.map((input) => [input.type, input.name, input.value])
    ).toEqual([
      ['hidden', 'scope', 'current'],
      ['hidden', 'workspace', 'org-acme'],
    ]);
  });

  test('sign out as a callback is a plain button, no form', () => {
    const onSignOut = mock(() => undefined);
    render(<AppShell {...PROPS} signOut={{ onSignOut, label: 'Log out' }} />);
    const button = screen.getByRole('button', { name: 'Log out' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.closest('form')).toBeNull();
    fireEvent.click(button);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  test('sidebarShortcut={false} leaves "[" alone; the button still toggles', () => {
    const view = render(
      <CommandPaletteProvider>
        <AppShell {...PROPS} sidebarShortcut={false} />
      </CommandPaletteProvider>
    );
    fireEvent.keyDown(document.body, { key: '[' });
    expect(document.documentElement.dataset.shellCollapsed).toBe('false');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(collapseButton().getAttribute('aria-label')).toBe(
      'Collapse sidebar'
    );
    // Nothing advertises a key the shell does not bind.
    expect(collapseButton().getAttribute('aria-keyshortcuts')).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(
      screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent
    ).not.toContain('Collapse or expand the sidebar');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(collapseButton());
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    view.unmount();

    // The default binds it.
    render(<AppShell {...PROPS} />);
    expect(collapseButton().getAttribute('aria-keyshortcuts')).toBe('[');
    fireEvent.keyDown(document.body, { key: '[' });
    expect(document.documentElement.dataset.shellCollapsed).toBe('false');
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  test('toggleShellCollapsed drives the rail from a host, as the button does', async () => {
    render(<AppShell {...PROPS} sidebarShortcut={false} />);
    expect(collapseButton().getAttribute('aria-label')).toBe(
      'Collapse sidebar'
    );
    // The host's own "[" handler: the attribute, the saved choice and the
    // button's label all move together, through the shell's attribute observer.
    let next = false;
    act(() => {
      next = toggleShellCollapsed(KEY);
    });
    expect(next).toBe(true);
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(
      await screen.findByRole('button', { name: 'Expand sidebar' })
    ).toBeTruthy();
    act(() => {
      next = toggleShellCollapsed(KEY);
    });
    expect(next).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(
      await screen.findByRole('button', { name: 'Collapse sidebar' })
    ).toBeTruthy();
  });

  test('chromeAttributes land on the brand row and the topbar', () => {
    render(
      <AppShell
        {...PROPS}
        chromeAttributes={{ 'data-tauri-drag-region': '' }}
      />
    );
    const brandRow = screen.getByRole('link', {
      name: 'Milestone Planner Acme',
    }).parentElement;
    expect(brandRow?.getAttribute('data-tauri-drag-region')).toBe('');
    expect(
      screen.getByRole('banner').getAttribute('data-tauri-drag-region')
    ).toBe('');
    // Nothing else takes them: the sidebar and the content stay plain.
    expect(document.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(
      2
    );
  });

  test('the brand row reads --shell-brand-inset as extra left padding', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'shell', 'app-shell.module.css'),
      'utf8'
    );
    // Expanded and collapsed: the inset adds to the row's own padding and
    // is 0 unless a host sets it (a Tauri window's traffic lights).
    expect(css).toMatch(
      /\.brand \{[^}]*padding: 8px 8px 4px calc\(8px \+ var\(--shell-brand-inset, 0px\)\);/
    );
    expect(css).toMatch(
      /\.brand \{[^}]*padding: 8px 6px 4px calc\(6px \+ var\(--shell-brand-inset, 0px\)\);/
    );
  });

  test('"[" collapses the sidebar and the choice persists', () => {
    const first = render(<AppShell {...PROPS} />);
    expect(collapseButton().getAttribute('aria-label')).toBe(
      'Collapse sidebar'
    );
    fireEvent.keyDown(document.body, { key: '[' });
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(collapseButton().getAttribute('aria-label')).toBe('Expand sidebar');
    first.unmount();

    render(<AppShell {...PROPS} />);
    expect(collapseButton().getAttribute('aria-label')).toBe('Expand sidebar');
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    fireEvent.click(collapseButton());
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(document.documentElement.dataset.shellCollapsed).toBe('false');
  });

  test('"[" is ignored while typing', () => {
    render(
      <AppShell {...PROPS}>
        <input aria-label="Filter" />
      </AppShell>
    );
    fireEvent.keyDown(screen.getByLabelText('Filter'), { key: '[' });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(collapseButton().getAttribute('aria-label')).toBe(
      'Collapse sidebar'
    );
  });

  test('tolerates storage that throws', () => {
    const original = Storage.prototype.setItem;
    const getOriginal = Storage.prototype.getItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      render(<AppShell {...PROPS} />);
      fireEvent.keyDown(document.body, { key: '[' });
      expect(collapseButton().getAttribute('aria-label')).toBe(
        'Expand sidebar'
      );
    } finally {
      Storage.prototype.setItem = original;
      Storage.prototype.getItem = getOriginal;
    }
  });

  test('the search trigger opens the command palette', () => {
    render(
      <CommandPaletteProvider
        items={[{ id: 'a', label: 'Go to Timeline', section: 'Navigation' }]}
      >
        <AppShell {...PROPS} />
      </CommandPaletteProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(
      screen.getByRole('dialog', { name: 'Command palette' })
    ).toBeTruthy();
  });

  test('on a phone, More opens the drawer as a modal dialog; Esc closes it', () => {
    const viewport = (
      window as unknown as {
        happyDOM: {
          setViewport: (v: { width: number; height: number }) => void;
        };
      }
    ).happyDOM;
    viewport.setViewport({ width: 390, height: 844 });
    try {
      render(
        <AppShell
          {...PROPS}
          tabs={[
            {
              id: 'week',
              label: 'My week',
              href: '/week',
              icon: CalendarCheck,
              current: true,
            },
          ]}
        />
      );
      const tabs = screen.getByRole('navigation', { name: 'Sections' });
      const more = screen.getByRole('button', { name: 'More' });
      expect(tabs.contains(more)).toBe(true);
      more.focus();
      fireEvent.click(more);
      expect(more.getAttribute('aria-expanded')).toBe('true');
      const drawer = screen.getByRole('dialog', { name: 'Sidebar' });
      expect(drawer.getAttribute('aria-modal')).toBe('true');
      expect(drawer.contains(document.activeElement)).toBe(true);
      // "[" does nothing on a phone (and nothing under a modal).
      fireEvent.keyDown(document.body, { key: '[' });
      expect(localStorage.getItem(KEY)).toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(more);
    } finally {
      viewport.setViewport({ width: 1024, height: 768 });
    }
  });

  test('a section action is named with its section ("All Projects")', () => {
    render(<AppShell {...PROPS} />);
    const all = screen.getByRole('link', { name: 'All Projects' });
    expect(all.getAttribute('href')).toBe('/projects');
  });

  test('the shortcuts sheet lists "[" on desktop, not on a phone', () => {
    const view = render(
      <CommandPaletteProvider>
        <AppShell {...PROPS} />
      </CommandPaletteProvider>
    );
    fireEvent.keyDown(document.body, { key: '?' });
    expect(
      screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent
    ).toContain('Collapse or expand the sidebar');
    view.unmount();

    const viewport = (
      window as unknown as {
        happyDOM: {
          setViewport: (v: { width: number; height: number }) => void;
        };
      }
    ).happyDOM;
    viewport.setViewport({ width: 390, height: 844 });
    try {
      render(
        <CommandPaletteProvider>
          <AppShell {...PROPS} />
        </CommandPaletteProvider>
      );
      fireEvent.keyDown(document.body, { key: '?' });
      expect(
        screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent
      ).not.toContain('Collapse or expand the sidebar');
    } finally {
      viewport.setViewport({ width: 1024, height: 768 });
    }
  });
});
