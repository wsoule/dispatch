import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import { Button, Menu, type MenuEntry, placeBeside } from '../src/index';

afterEach(cleanup);

// Menu: roles, keyboard, focus and dismissal; the open menu and each open
// submenu as layers of the overlay stack (Escape and presses peel one
// layer at a time); placement through the --menu-* and --submenu-*
// properties, following the anchor; and the submenu's pure placement.
// Menu nested in a Dialog, a modal SlideOver or under the command palette
// is in shell-layer-stack.test.tsx.

function entries(
  log: (what: string) => void,
  view: string,
  setView: (view: string) => void
): MenuEntry[] {
  return [
    {
      kind: 'group',
      id: 'show',
      label: 'Show',
      items: ['All', 'Mine'].map((name) => ({
        kind: 'radio' as const,
        id: name,
        label: name,
        checked: view === name,
        onSelect: () => setView(name),
      })),
    },
    { kind: 'separator' },
    {
      id: 'settings',
      label: 'Settings',
      shortcut: 'G then S',
      onSelect: () => log('settings'),
    },
    {
      id: 'hidden',
      label: 'Hide column',
      disabled: true,
      onSelect: () => log('hide'),
    },
    {
      kind: 'submenu',
      id: 'switch',
      label: 'Switch project',
      items: [{ id: 'atlas', label: 'Atlas', onSelect: () => log('atlas') }],
    },
    {
      id: 'discard',
      label: 'Discard the run',
      destructive: true,
      onSelect: () => log('discard'),
    },
  ];
}

function MenuHost({ log }: { log: (what: string) => void }) {
  const [view, setView] = useState('All');
  return (
    <Menu
      label="Project"
      items={entries(log, view, setView)}
      trigger={(props) => <Button {...props}>Project</Button>}
    />
  );
}

describe('Menu', () => {
  test('a button opens a labelled menu of menuitems', () => {
    render(<MenuHost log={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Project' });
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    const all = screen.getByRole('menuitemradio', { name: 'All' });
    expect(all.getAttribute('aria-checked')).toBe('true');
    const discard = screen.getByRole('menuitem', { name: 'Discard the run' });
    expect(discard.getAttribute('data-destructive')).toBe('true');
    // The shortcut is a visual hint, not part of the name.
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
  });

  test('keyboard: ArrowDown opens on the first row; arrows skip disabled rows and wrap', () => {
    render(<MenuHost log={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitemradio', { name: 'All' })
    );
    const menu = screen.getByRole('menu', { name: 'Project' });
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Settings');
    // "Hide column" is disabled, so the next stop is the submenu row.
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Switch project');
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'End' });
    expect(document.activeElement?.textContent).toContain('Discard the run');
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('All');
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('Discard the run');
  });

  test('ArrowUp on the trigger opens on the last row', () => {
    render(<MenuHost log={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('Discard the run');
  });

  test('picking a row runs it, closes the menu and refocuses the trigger', () => {
    const log = mock((_what: string) => undefined);
    render(<MenuHost log={log} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(log).toHaveBeenCalledWith('settings');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // A radio row ticks the new choice.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Mine' }));
    fireEvent.click(trigger);
    expect(
      screen
        .getByRole('menuitemradio', { name: 'Mine' })
        .getAttribute('aria-checked')
    ).toBe('true');
  });

  test('a submenu opens with ArrowRight and closes with ArrowLeft', () => {
    const log = mock((_what: string) => undefined);
    render(<MenuHost log={log} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    const row = screen.getByRole('menuitem', { name: 'Switch project' });
    expect(row.getAttribute('aria-haspopup')).toBe('menu');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const atlas = screen.getByRole('menuitem', { name: 'Atlas' });
    expect(document.activeElement).toBe(atlas);
    fireEvent.keyDown(atlas, { key: 'ArrowLeft' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(row);
    // The root menu is still open; Esc there closes it.
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Project' })
    );
  });

  test('a submenu row runs and closes everything', () => {
    const log = mock((_what: string) => undefined);
    render(<MenuHost log={log} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch project' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Atlas' }));
    expect(log).toHaveBeenCalledWith('atlas');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('Esc in the menu is not left for an outer dialog; a press outside closes it', () => {
    const outer = mock((_event: KeyboardEvent) => undefined);
    render(
      <>
        <MenuHost log={() => undefined} />
        <p>Elsewhere</p>
      </>
    );
    document.addEventListener('keydown', outer);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(outer.mock.calls.every(([event]) => event.defaultPrevented)).toBe(
      true
    );
    document.removeEventListener('keydown', outer);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

/** Escape where focus is now, as a keyboard would send it. */
function escape(): void {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: 'Escape',
  });
}

/** The open menu named `name`, or null. */
function menuNamed(name: string): HTMLElement | null {
  return screen.queryByRole('menu', { name });
}

/** The popover layer around an open menu list. */
function layerOf(menu: HTMLElement): HTMLElement {
  const layer = menu.parentElement;
  if (layer === null) throw new Error('no layer');
  return layer;
}

/** Opens the Project menu and its Switch project submenu from the
    keyboard: focus ends on the submenu's first row. */
function openSubmenu(): { trigger: HTMLElement; row: HTMLElement } {
  const trigger = screen.getByRole('button', { name: 'Project' });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const row = screen.getByRole('menuitem', { name: 'Switch project' });
  act(() => row.focus());
  fireEvent.keyDown(row, { key: 'ArrowRight' });
  expect(menuNamed('Switch project')).not.toBeNull();
  return { trigger, row };
}

/** Pretends `element` sits at `box` in the viewport (happy-dom lays
    nothing out). */
function placeAt(
  element: HTMLElement,
  box: { top: number; left: number; width: number; height: number }
): void {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    }) as DOMRect;
}

/** One animation frame, after which a scheduled re-placement has run. */
async function nextFrame(): Promise<void> {
  await act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  );
}

describe('Menu on the layer stack', () => {
  test('Escape peels the submenu, then the menu, and the page never sees either', () => {
    const page = mock((_event: KeyboardEvent) => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') page(event);
    };
    render(<MenuHost log={() => undefined} />);
    document.addEventListener('keydown', onKey);
    try {
      const { trigger, row } = openSubmenu();
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'Atlas' })
      );
      escape();
      expect(menuNamed('Switch project')).toBeNull();
      expect(menuNamed('Project')).not.toBeNull();
      expect(document.activeElement).toBe(row);
      escape();
      expect(menuNamed('Project')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(page).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('Escape with focus back on the submenu’s row closes only the submenu', () => {
    render(<MenuHost log={() => undefined} />);
    const { trigger, row } = openSubmenu();
    // Focus on the opener row counts as the submenu's own: it stays open.
    act(() => row.focus());
    expect(menuNamed('Switch project')).not.toBeNull();
    escape();
    expect(menuNamed('Switch project')).toBeNull();
    expect(menuNamed('Project')).not.toBeNull();
    expect(document.activeElement).toBe(row);
    escape();
    expect(menuNamed('Project')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('a press in the menu outside the submenu closes only the submenu', () => {
    render(<MenuHost log={() => undefined} />);
    openSubmenu();
    fireEvent.pointerDown(screen.getByText('Show'));
    expect(menuNamed('Switch project')).toBeNull();
    expect(menuNamed('Project')).not.toBeNull();
  });

  test('a press on the page closes the submenu and the menu together', () => {
    render(
      <>
        <MenuHost log={() => undefined} />
        <p>Elsewhere</p>
      </>
    );
    openSubmenu();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(menuNamed('Switch project')).toBeNull();
    expect(menuNamed('Project')).toBeNull();
  });

  test('a press on the trigger is not outside: its click toggles the menu', () => {
    render(<MenuHost log={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(trigger);
    expect(menuNamed('Project')).not.toBeNull();
    fireEvent.click(trigger);
    expect(menuNamed('Project')).toBeNull();
  });

  test('focus moving out of the menu closes it and stays where it went', () => {
    render(
      <>
        <MenuHost log={() => undefined} />
        <button type="button">Elsewhere</button>
      </>
    );
    openSubmenu();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());
    expect(menuNamed('Switch project')).toBeNull();
    expect(menuNamed('Project')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  test('a host’s data-* hooks and data-picker-popup sit on the root layer; the submenu is inside it', () => {
    render(
      <Menu
        label="Project"
        data-testid="project-menu"
        items={entries(
          () => undefined,
          'All',
          () => undefined
        )}
        trigger={(props) => <Button {...props}>Project</Button>}
      />
    );
    const { trigger } = openSubmenu();
    const root = layerOf(screen.getByRole('menu', { name: 'Project' }));
    expect(root.getAttribute('data-testid')).toBe('project-menu');
    expect(root.hasAttribute('data-picker-popup')).toBe(true);
    expect(root.getAttribute('popover')).toBe('manual');
    expect(trigger.hasAttribute('data-testid')).toBe(false);
    const sub = layerOf(screen.getByRole('menu', { name: 'Switch project' }));
    expect(sub.hasAttribute('data-picker-popup')).toBe(false);
    expect(sub.getAttribute('popover')).toBe('manual');
    expect(root.contains(sub)).toBe(true);
    expect(sub.closest('[data-picker-popup]')).toBe(root);
  });
});

describe('Menu placement', () => {
  test('the menu sits under its trigger through --menu-*, the submenu beside its row through --submenu-*', () => {
    render(<MenuHost log={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    placeAt(trigger, { top: 100, left: 40, width: 120, height: 30 });
    fireEvent.click(trigger);
    const root = layerOf(screen.getByRole('menu', { name: 'Project' }));
    expect(root.dataset.placed).toBe('true');
    expect(root.dataset.side).toBe('below');
    expect(root.style.getPropertyValue('--menu-top')).toBe('134px');
    expect(root.style.getPropertyValue('--menu-left')).toBe('40px');
    const row = screen.getByRole('menuitem', { name: 'Switch project' });
    placeAt(row, { top: 200, left: 44, width: 200, height: 30 });
    fireEvent.click(row);
    const sub = layerOf(screen.getByRole('menu', { name: 'Switch project' }));
    expect(sub.dataset.placed).toBe('true');
    expect(sub.dataset.side).toBe('right');
    expect(sub.style.getPropertyValue('--submenu-left')).toBe('246px');
    expect(sub.style.getPropertyValue('--submenu-top')).toBe('196px');
    // Its own properties only: it would inherit the root's --menu-*.
    expect(sub.style.getPropertyValue('--menu-top')).toBe('');
  });

  test('both follow their anchors when the page scrolls', async () => {
    render(<MenuHost log={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    placeAt(trigger, { top: 100, left: 40, width: 120, height: 30 });
    fireEvent.click(trigger);
    const row = screen.getByRole('menuitem', { name: 'Switch project' });
    placeAt(row, { top: 200, left: 44, width: 200, height: 30 });
    fireEvent.click(row);
    const root = layerOf(screen.getByRole('menu', { name: 'Project' }));
    const sub = layerOf(screen.getByRole('menu', { name: 'Switch project' }));
    placeAt(trigger, { top: 60, left: 40, width: 120, height: 30 });
    placeAt(row, { top: 160, left: 44, width: 200, height: 30 });
    fireEvent.scroll(document);
    await nextFrame();
    expect(root.style.getPropertyValue('--menu-top')).toBe('94px');
    expect(sub.style.getPropertyValue('--submenu-top')).toBe('156px');
  });

  test('menu.module.css reads the properties, animates the list and draws an edge in forced colours', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'controls', 'menu.module.css'),
      'utf8'
    );
    expect(css).toContain('var(--menu-top, 0)');
    expect(css).toContain('var(--menu-bottom, 0)');
    expect(css).toContain('var(--submenu-top, 0)');
    expect(css).toContain('var(--submenu-left, 0)');
    // The placed layer itself never moves: positionLayer measures it.
    expect(css).toMatch(
      /\.layer\[data-placed='true'\] > \.menu \{[^}]*animation/
    );
    expect(css).not.toMatch(/\.layer\[data-placed='true'\] \{[^}]*animation/);
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\/\*[^*]*\*\/\s*\.layer \{\s*border: 1px solid CanvasText;/
    );
  });
});

describe('placeBeside', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 300 };

  test('opens to the right, level with the row', () => {
    const anchor = { top: 100, bottom: 130, left: 300, right: 500 };
    expect(placeBeside({ anchor, size, viewport })).toEqual({
      side: 'right',
      left: 502,
      top: 96,
    });
  });

  test('flips left at the right edge and slides up at the bottom', () => {
    const anchor = { top: 700, bottom: 730, left: 700, right: 900 };
    expect(placeBeside({ anchor, size, viewport })).toEqual({
      side: 'left',
      left: 498,
      top: 492,
    });
  });
});
