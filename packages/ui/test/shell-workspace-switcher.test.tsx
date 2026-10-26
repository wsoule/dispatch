// cspell:ignore Acmelinear Gglobex -- textContent concatenations asserted below
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CalendarCheck } from 'lucide-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import AppShell from '../src/shell/app-shell';
import { CommandPaletteProvider } from '../src/shell/command-palette';
import { ToastProvider } from '../src/shell/toast';
import type { AppShellProps, ShellWorkspaceSwitcher } from '../src/shell/types';

// The brand row as the workspace switcher (AppShellProps.workspaceSwitcher):
// its name and ARIA, the menu (rows by name, the current one active and
// ticked, the connect row), the keyboard, the save contract ("Switching",
// "Not switched …", a toast on the collapsed rail), and the keys it keeps
// from the shell's "[" and the palette's shortcuts.

const KEY = 'test-switcher-collapsed';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.shellCollapsed;
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

function switcher(
  overrides: Partial<ShellWorkspaceSwitcher> = {}
): ShellWorkspaceSwitcher {
  return {
    // Given out of order: the menu lists them by name.
    workspaces: [
      { id: 'org-initech', name: 'Initech', hint: 'Reinstall needed' },
      { id: 'org-acme', name: 'Acme', hint: 'linear.app/acme', current: true },
      { id: 'org-globex', name: 'globex', hint: 'Guest' },
    ],
    onSwitch: () => undefined,
    connect: { label: 'Connect another workspace', href: '/setup/connect' },
    ...overrides,
  };
}

function props(workspaceSwitcher?: ShellWorkspaceSwitcher): AppShellProps {
  return {
    appName: 'Milestone Planner',
    workspaceName: 'Acme',
    brandHref: '/week',
    workspaceSwitcher,
    nav: [
      {
        id: 'week',
        label: 'My week',
        href: '/week',
        icon: CalendarCheck,
        current: true,
      },
    ],
    user: { name: 'Pat Lee' },
    signOut: { action: '/api/auth/logout', method: 'post' },
    storageKey: KEY,
  };
}

const NAME = 'Milestone Planner Acme, switch workspace';

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: NAME });
}

function listbox(): HTMLElement {
  return screen.getByRole('listbox', { name: 'Workspace' });
}

function activeOption(): HTMLElement | null {
  return document.getElementById(
    listbox().getAttribute('aria-activedescendant') ?? ''
  );
}

function optionLabels(): string[] {
  return within(listbox())
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

/** Replaces window.location.assign for the length of `run`. */
function withAssign(run: (assign: ReturnType<typeof mock>) => void): void {
  const assign = mock((_href: string) => undefined);
  const original = window.location.assign;
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    value: assign,
  });
  try {
    run(assign);
  } finally {
    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: original,
    });
  }
}

describe('the workspace switcher', () => {
  test('the brand row is a menu button named with the visible words first', () => {
    const { container } = render(<AppShell {...props(switcher())} />);
    const button = trigger();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('data-appearance')).toBe('brand');
    // The face keeps the brand link's words and tile ("MP"), hidden behind
    // the name, plus the chevron.
    expect(button.textContent).toBe('MPMilestone PlannerAcme');
    expect(button.querySelector('svg.lucide-chevrons-up-down')).not.toBeNull();
    // It replaces the brand link, and its row's rail tooltip names it.
    expect(screen.queryByRole('link', { name: /Milestone Planner/ })).toBe(
      null
    );
    expect(button.closest('[data-tip]')?.getAttribute('data-tip')).toBe(
      'Acme · Switch workspace'
    );
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy();
    // No decorative childless hidden spans, menu open or not.
    const sidebar = container.querySelector('aside');
    const marks = [
      ...(sidebar?.querySelectorAll('span[aria-hidden="true"]') ?? []),
    ].filter((span) => span.childNodes.length === 0);
    expect(marks).toHaveLength(0);
  });

  test('a host label changes the action words', () => {
    render(<AppShell {...props(switcher({ label: 'Change workspace' }))} />);
    const button = screen.getByRole('button', {
      name: 'Milestone Planner Acme, change workspace',
    });
    expect(button.closest('[data-tip]')?.getAttribute('data-tip')).toBe(
      'Acme · Change workspace'
    );
  });

  test('opens on the current workspace; rows by name, then the connect row', () => {
    render(<AppShell {...props(switcher())} />);
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(listbox());
    expect(optionLabels()).toEqual([
      'AAcmelinear.app/acme',
      'GglobexGuest',
      'IInitechReinstall needed',
      'Connect another workspace',
    ]);
    const acme = screen.getByRole('option', { name: /Acme/ });
    expect(activeOption()).toBe(acme);
    expect(acme.getAttribute('aria-selected')).toBe('true');
    expect(acme.querySelector('svg.lucide-check')).not.toBeNull();
    // Two groups: "Workspaces" (its visible title) and the connect row's,
    // which shows only the divider but still names its group.
    const groups = within(listbox()).getAllByRole('group');
    expect(
      groups.map((group) => group.getAttribute('aria-labelledby'))
    ).toHaveLength(2);
    expect(within(groups[0]).getAllByRole('option')).toHaveLength(3);
    const titles = groups.map((group) =>
      document.getElementById(group.getAttribute('aria-labelledby') ?? '')
    );
    expect(titles.map((title) => title?.textContent)).toEqual([
      'Workspaces',
      'Connect',
    ]);
    expect(titles[0]?.parentElement?.className).not.toContain('srOnly');
    expect(titles[1]?.parentElement?.className).toContain('srOnly');
    const connect = screen.getByRole('option', {
      name: 'Connect another workspace',
    });
    expect(connect.getAttribute('aria-selected')).toBe('false');
    expect(connect.querySelector('svg.lucide-plus')).not.toBeNull();
  });

  test('↓ then Enter switches; "Switching" shows until the promise settles', async () => {
    const pending = deferred();
    const onSwitch = mock((_id: string) => pending.promise);
    render(<AppShell {...props(switcher({ onSwitch }))} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(listbox(), { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toContain('globex');
    fireEvent.keyDown(listbox(), { key: 'ArrowUp' });
    expect(activeOption()?.textContent).toContain('Acme');
    fireEvent.keyDown(listbox(), { key: 'ArrowDown' });
    fireEvent.keyDown(listbox(), { key: 'Enter' });
    expect(onSwitch.mock.calls).toEqual([['org-globex']]);
    // The menu closed, focus is back on the row, and its workspace line
    // says where it is going (the picker's own "Switching" note is there
    // for the stylesheet to leave out, and the polite status speaks it).
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().textContent).toBe(
      'MPMilestone PlannerSwitching to globex'
    );
    expect(trigger().getAttribute('aria-label')).toBe(NAME);
    const note = document.querySelector('[data-edit-pending]');
    expect(note?.textContent).toBe('Switching');
    expect(trigger().getAttribute('data-pending')).toBe('true');
    expect(
      screen
        .getAllByRole('status')
        .some((status) => status.textContent === 'Switching Workspace')
    ).toBe(true);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(document.querySelector('[data-edit-pending]')).toBeNull();
    // Done (a host that stays on the page moves `current` itself).
    expect(trigger().textContent).toBe('MPMilestone PlannerAcme');
  });

  test('a refused switch rolls back and says "Not switched …"', async () => {
    const pending = deferred();
    const onSwitch = mock((_id: string) => pending.promise);
    render(<AppShell {...props(switcher({ onSwitch }))} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Initech/ }));
    expect(onSwitch.mock.calls).toEqual([['org-initech']]);
    await act(async () => {
      pending.reject(new Error('Your session for Initech ended.'));
      await pending.promise.catch(() => undefined);
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(
      'Not switchedYour session for Initech ended.'
    );
    expect(trigger().textContent).toBe('MPMilestone PlannerAcme');
    expect(alert.getAttribute('data-edit-error')).toBe('');
    expect(trigger().getAttribute('aria-describedby')).toBe(alert.id);
    // Reopened, the current workspace is still the ticked one, and the
    // menu's foot repeats the error.
    fireEvent.click(trigger());
    const acme = screen.getByRole('option', { name: /Acme/ });
    expect(acme.getAttribute('aria-selected')).toBe('true');
    expect(
      screen
        .getByRole('option', { name: /Initech/ })
        .getAttribute('aria-selected')
    ).toBe('false');
    expect(
      within(screen.getByRole('dialog')).getByRole('alert').textContent
    ).toContain('Your session for Initech ended.');
  });

  test('picking the current workspace does nothing', () => {
    const onSwitch = mock((_id: string) => undefined);
    render(<AppShell {...props(switcher({ onSwitch }))} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(listbox(), { key: 'Enter' });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-edit-pending]')).toBeNull();
  });

  test('Esc closes the menu and returns focus to the row', () => {
    render(<AppShell {...props(switcher())} />);
    const button = trigger();
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(listbox());
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  test('Home and End jump to the first and last rows', () => {
    render(<AppShell {...props(switcher())} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(listbox(), { key: 'End' });
    expect(activeOption()?.textContent).toBe('Connect another workspace');
    fireEvent.keyDown(listbox(), { key: 'Home' });
    expect(activeOption()?.textContent).toContain('Acme');
  });

  test('the connect row is a full page load, with no "Switching" note', () => {
    const onSwitch = mock((_id: string) => undefined);
    render(<AppShell {...props(switcher({ onSwitch }))} />);
    withAssign((assign) => {
      fireEvent.click(trigger());
      fireEvent.keyDown(listbox(), { key: 'End' });
      fireEvent.keyDown(listbox(), { key: 'Enter' });
      expect(assign.mock.calls).toEqual([['/setup/connect']]);
    });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-edit-pending]')).toBeNull();
    expect(trigger().getAttribute('data-pending')).toBeNull();
    // Reopened, the connect row is not chosen; the current one still is.
    fireEvent.click(trigger());
    expect(
      screen
        .getByRole('option', { name: 'Connect another workspace' })
        .getAttribute('aria-selected')
    ).toBe('false');
    expect(activeOption()?.textContent).toContain('Acme');
  });

  test('no connect row without `connect`', () => {
    render(<AppShell {...props(switcher({ connect: undefined }))} />);
    fireEvent.click(trigger());
    expect(optionLabels()).toHaveLength(3);
    expect(within(listbox()).getAllByRole('group')).toHaveLength(1);
  });

  test('without a current row the shell workspace name is used', () => {
    render(
      <AppShell
        {...props(
          switcher({
            workspaces: [
              { id: 'org-globex', name: 'Globex' },
              { id: 'org-initech', name: 'Initech' },
            ],
          })
        )}
      />
    );
    fireEvent.click(trigger());
    // Nothing is ticked; the first row is active.
    expect(
      within(listbox())
        .getAllByRole('option')
        .filter((option) => option.getAttribute('aria-selected') === 'true')
    ).toHaveLength(0);
    expect(activeOption()?.textContent).toContain('Globex');
  });
});

describe('the workspace switcher on the collapsed rail', () => {
  function collapse(): void {
    localStorage.setItem(KEY, '1');
  }

  test('keeps its accessible name; the words and chevron are hidden by the rail', () => {
    collapse();
    render(<AppShell {...props(switcher())} />);
    const button = trigger();
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    // The name is on the button; the words the rail hides (the names and
    // the chevron) are presentation inside it.
    expect(button.getAttribute('aria-label')).toBe(NAME);
    expect(
      [...button.querySelectorAll('[aria-hidden="true"]')].map((el) =>
        el.tagName.toLowerCase()
      )
    ).toEqual(['span', 'span', 'svg']);
    // The rail tooltip says which workspace and what the row does.
    fireEvent.mouseOver(button);
    expect(screen.getByText('Acme · Switch workspace')).toBeTruthy();
    // No tooltip beside the open menu.
    fireEvent.click(button);
    expect(screen.queryByText('Acme · Switch workspace')).toBeNull();
    fireEvent.mouseOver(screen.getByRole('option', { name: /globex/ }));
    expect(screen.queryByText('Acme · Switch workspace')).toBeNull();
    const css = readFileSync(
      path.join(import.meta.dir, '../src/shell/app-shell.module.css'),
      'utf8'
    );
    expect(css).toMatch(
      /:global\(html\[data-shell-collapsed='true'\]\) \.brandText,\s*:global\(html\[data-shell-collapsed='true'\]\) \.brandChevron \{\s*display: none;/
    );
  });

  test('a refused switch also goes to a toast, where there is room', async () => {
    collapse();
    const pending = deferred();
    render(
      <ToastProvider>
        <AppShell {...props(switcher({ onSwitch: () => pending.promise }))} />
      </ToastProvider>
    );
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /globex/ }));
    await act(async () => {
      pending.reject(new Error('Your session for Globex ended.'));
      await pending.promise.catch(() => undefined);
    });
    const stack = screen.getByRole('region', { name: 'Notifications' });
    expect(stack.textContent).toContain(
      'Not switched Your session for Globex ended.'
    );
    // The picker still rolled back: reopened, Acme is the ticked row.
    fireEvent.click(trigger());
    expect(
      screen.getByRole('option', { name: /Acme/ }).getAttribute('aria-selected')
    ).toBe('true');
  });

  test("the rail's rules hide the line under the tile, never the menu foot's repeat", async () => {
    collapse();
    const pending = deferred();
    render(
      <ToastProvider>
        <AppShell {...props(switcher({ onSwitch: () => pending.promise }))} />
      </ToastProvider>
    );
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /globex/ }));
    await act(async () => {
      pending.reject(new Error('Your session for Globex ended.'));
      await pending.promise.catch(() => undefined);
    });
    // Closed: the line under the tile is a direct child of the picker's
    // root, the element the switcher's class (and the rail's rules) sit
    // on.
    const [line] = document.querySelectorAll('[data-edit-error]');
    expect(line?.parentElement?.hasAttribute('data-picker')).toBe(true);
    // Reopened: the foot repeats it inside the menu, deeper than a child,
    // so the child-combinator rules below never clip or hide it.
    fireEvent.click(trigger());
    const popup = document.querySelector('[data-picker-popup]');
    const foot = popup?.querySelector('[data-edit-error]');
    expect(foot?.textContent).toContain('Your session for Globex ended.');
    expect(foot?.parentElement?.hasAttribute('data-picker')).toBe(false);
    const css = readFileSync(
      path.join(import.meta.dir, '../src/shell/app-shell.module.css'),
      'utf8'
    );
    const selectors = [
      ...css.matchAll(/([^{};/]*\[data-edit-error\][^{]*)\{/g),
    ].map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim());
    expect(selectors.length).toBeGreaterThanOrEqual(3);
    for (const selector of selectors) {
      expect(selector).toMatch(/\.switcher(Toasted)? > \[data-edit-error\]$/);
    }
  });

  test('expanded, a refused switch does not toast', async () => {
    const pending = deferred();
    render(
      <ToastProvider>
        <AppShell {...props(switcher({ onSwitch: () => pending.promise }))} />
      </ToastProvider>
    );
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /globex/ }));
    await act(async () => {
      pending.reject(new Error('Your session for Globex ended.'));
      await pending.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
    expect(document.querySelector('[data-edit-error]')?.textContent).toBe(
      'Not switchedYour session for Globex ended.'
    );
  });
});

describe('keys inside the open switcher stay in it', () => {
  test('"[" does not collapse the sidebar from inside the menu', () => {
    render(<AppShell {...props(switcher())} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(listbox(), { key: '[' });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' })
    ).toBeTruthy();
    // Outside the menu "[" still works.
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: '[' });
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  test('the palette shortcuts, "?" and Ctrl K do not fire from inside the menu', () => {
    const navigate = mock((_href: string) => undefined);
    render(
      <CommandPaletteProvider
        navigate={navigate}
        items={[
          {
            id: 'nav-week',
            label: 'Go to My week',
            section: 'Navigation',
            href: '/week',
            shortcut: ['G', 'W'],
          },
        ]}
      >
        <AppShell {...props(switcher())} />
      </CommandPaletteProvider>
    );
    fireEvent.click(trigger());
    const list = listbox();
    fireEvent.keyDown(list, { key: 'g' });
    fireEvent.keyDown(list, { key: 'w' });
    fireEvent.keyDown(list, { key: '?' });
    fireEvent.keyDown(list, { key: 'k', ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBe(
      null
    );
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBe(
      null
    );
    // The menu is still open, and outside it the shortcut works.
    expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy();
    fireEvent.keyDown(list, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'w' });
    expect(navigate.mock.calls).toEqual([['/week']]);
  });
});

describe('the switcher stylesheets', () => {
  const pickerCss = readFileSync(
    path.join(import.meta.dir, '../src/edit/picker-popover.module.css'),
    'utf8'
  );
  const shellCss = readFileSync(
    path.join(import.meta.dir, '../src/shell/app-shell.module.css'),
    'utf8'
  );

  test("the 'brand' appearance: the brand link's row, filled on hover and while open", () => {
    expect(pickerCss).toMatch(/^\.brand \{[^}]*padding: 5px 6px;/m);
    expect(pickerCss).toMatch(
      /^\.brand\[aria-expanded='true'\] \{\s*background: var\(--surface-3\);/m
    );
    expect(pickerCss).toMatch(
      /\.brand:not\(:disabled\):hover \{\s*background: var\(--surface-3\);/
    );
  });

  test('the row keeps the collapse button beside it; "Switching" is the workspace line', () => {
    expect(shellCss).toMatch(/\.brand > \.switcher \{\s*display: contents;/);
    expect(shellCss).toMatch(
      /\.switcher > \[data-edit-error\] \{\s*order: 1;\s*flex: 1 0 100%;/
    );
    expect(shellCss).toMatch(
      /\.switcher \[data-edit-pending\] \{\s*display: none;/
    );
    expect(pickerCss).toMatch(
      /\.brandRoot > \.triggerRow \{\s*display: flex;\s*flex: 1 1 0;/
    );
  });

  test('forced colours outline the row while its menu is open', () => {
    expect(pickerCss).toMatch(
      /@media \(forced-colors: active\) \{\s*\.brand\[aria-expanded='true'\] \{\s*outline: 1px solid CanvasText;/
    );
  });

  test('forced colours keep the initials tiles square, the current one filled', () => {
    // Forced colours drop background and box-shadow, the only things that
    // drew the tiles: an edge keeps each square, and the current
    // workspace's stays filled so it differs from the others.
    const forced = [
      ...shellCss.matchAll(
        /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/g
      ),
    ]
      .map((m) => m[1] ?? '')
      .join('\n');
    expect(forced).toMatch(
      /\.logo,\s*\.workspaceTile \{\s*border: 1px solid CanvasText;/
    );
    expect(forced).toMatch(
      /\.workspaceTileCurrent \{\s*forced-color-adjust: none;\s*background: CanvasText;\s*color: Canvas;/
    );
  });

  test('reduced motion stills the chevron with the rest of the row', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\) \{([^}]*)\{/.exec(
        shellCss
      )?.[1];
    expect(reduced).toContain('.brandChevron');
    expect(reduced).toContain('.brandLink');
    // The trigger itself is the picker's, already in its list.
    expect(pickerCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.trigger,/
    );
  });
});
