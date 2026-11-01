import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { useRef, useState } from 'react';

import {
  Button,
  Menu,
  type MenuEntry,
  placeBeside,
  Popover,
  Tooltip,
} from '../src/index';

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

// Menu, Popover and Tooltip: roles, keyboard, focus and dismissal, plus
// the submenu's pure placement.

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

function PopoverHost() {
  const focusRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Popover
        label="More options"
        initialFocusRef={focusRef}
        trigger={(props) => (
          <Button {...props} variant="quiet">
            More options
          </Button>
        )}
      >
        <button type="button">First</button>
        <input ref={focusRef} aria-label="Files it may change" />
      </Popover>
      <button type="button">Outside</button>
    </>
  );
}

describe('Popover', () => {
  test('opens a labelled dialog and focuses the initial element', () => {
    render(<PopoverHost />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'More options' });
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Files it may change' })
    );
  });

  test('Esc closes it and returns focus to the trigger', () => {
    render(<PopoverHost />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('focus leaving it, or a press outside, closes it', () => {
    render(<PopoverHost />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    const outside = screen.getByRole('button', { name: 'Outside' });
    fireEvent.click(trigger);
    fireEvent.blur(screen.getByRole('button', { name: 'First' }), {
      relatedTarget: outside,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('controlled, it reports the change and follows the host', () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    render(
      <Popover
        label="Due date"
        open={false}
        onOpenChange={onOpenChange}
        trigger={(props) => <Button {...props}>Due</Button>}
      >
        <p>Calendar</p>
      </Popover>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Due' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Tooltip', () => {
  test('describes the wrapped control and shows on hover after a pause', () => {
    jest.useFakeTimers();
    render(
      <Tooltip content="Open the flight plan">
        <Button aria-label="Flight plan">FP</Button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'Flight plan' });
    const tip = document.getElementById(
      button.getAttribute('aria-describedby') ?? ''
    );
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe('Open the flight plan');
    expect(tip?.hidden).toBe(true);
    const anchor = button.parentElement as HTMLElement;
    fireEvent.pointerEnter(anchor, { pointerType: 'mouse' });
    expect(tip?.hidden).toBe(true);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(tip?.hidden).toBe(false);
    fireEvent.pointerLeave(anchor, { pointerType: 'mouse' });
    expect(tip?.hidden).toBe(true);
  });

  test('keeps the control description it already had', () => {
    const { unmount } = render(
      <>
        <span id="note">Locked by policy</span>
        <Tooltip content="Why">
          <button type="button" aria-describedby="note">
            Edit
          </button>
        </Tooltip>
      </>
    );
    const button = screen.getByRole('button', { name: 'Edit' });
    const ids = (button.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids[0]).toBe('note');
    expect(ids).toHaveLength(2);
    unmount();
  });

  test('Esc hides a shown tip before anything behind it', () => {
    jest.useFakeTimers();
    const outer = mock((_event: KeyboardEvent) => undefined);
    render(
      <Tooltip content="Makes one tiny call">
        <Button>Test</Button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'Test' });
    fireEvent.pointerEnter(button.parentElement as HTMLElement, {
      pointerType: 'mouse',
    });
    act(() => {
      jest.advanceTimersByTime(600);
    });
    const tip = screen.getByRole('tooltip');
    expect(tip.hidden).toBe(false);
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(button, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(screen.getByRole('tooltip', { hidden: true }).hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
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
