import { render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { Activity, type ComponentProps, createElement } from 'react';

import type { GlobalKeyCommand } from '../lib/keyboard';
import {
  isAnyModalOpen,
  isApplePlatform,
  isShown,
  isTypingTarget,
  useGlobalKeyboard,
} from './useGlobalKeyboard';

// Fires a real `keydown` on `window`, optionally pre-cancelled the way an overlay
// cancels Escape when it dismisses itself — before this listener ever sees the event, not as
// a side effect of it.
function dispatchKeydown(key: string, { defaultPrevented = false } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    bubbles: true,
  });
  if (defaultPrevented) event.preventDefault();
  window.dispatchEvent(event);
  return event;
}

function mount(prefixTimeoutMs?: number) {
  const commands: GlobalKeyCommand[] = [];
  // A fresh arrow per render, the way App.tsx passes `onCommand` inline.
  const { rerender } = renderHook(() =>
    useGlobalKeyboard({ onCommand: (c) => commands.push(c), prefixTimeoutMs })
  );
  return { commands, rerender };
}

// Stands in for an open @dispatch/ui ConfirmDialog (FirstTaskGuide's "Close the guide?"): an
// alertdialog marked aria-modal while open, removed from the DOM on close.
function mountOpenDialog() {
  const el = document.createElement('div');
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useGlobalKeyboard', () => {
  test('a plain Escape resolves to a command', () => {
    const { commands } = mount();
    dispatchKeydown('Escape');
    expect(commands).toEqual(['escape']);
  });

  test('an Escape an overlay already defaultPrevented never reaches onCommand', () => {
    const { commands } = mount();
    dispatchKeydown('Escape', { defaultPrevented: true });
    expect(commands).toEqual([]);
  });

  test('"g" then "s" completes the chord; the prefix key itself is swallowed', () => {
    const { commands } = mount();
    const g = dispatchKeydown('g');
    expect(g.defaultPrevented).toBe(true);
    expect(commands).toEqual([]);
    dispatchKeydown('s');
    expect(commands).toEqual(['goto-settings']);
    // The prefix is spent: a second "s" is nothing at the global layer.
    dispatchKeydown('s');
    expect(commands).toEqual(['goto-settings']);
  });

  test('a chord miss drops the prefix and lets the key through', () => {
    const { commands } = mount();
    dispatchKeydown('g');
    const miss = dispatchKeydown('z');
    expect(miss.defaultPrevented).toBe(false);
    // "c" now means "new task" again, not "g c".
    dispatchKeydown('c');
    expect(commands).toEqual(['new-task']);
  });

  test('a key a view already consumed still ends the chord', () => {
    const { commands } = mount();
    dispatchKeydown('g');
    // The Cockpit handles `g p` itself and cancels the "p".
    dispatchKeydown('p', { defaultPrevented: true });
    // A fresh `g t` is a clean chord, not a stale `g` swallowing the next one.
    dispatchKeydown('g');
    dispatchKeydown('t');
    expect(commands).toEqual(['goto-tasks']);
  });

  test('a bare modifier keydown does not end the chord', () => {
    const { commands } = mount();
    dispatchKeydown('g');
    dispatchKeydown('Shift');
    dispatchKeydown('t');
    expect(commands).toEqual(['goto-tasks']);
  });

  test('the prefix expires after the chord window', async () => {
    const { commands } = mount(20);
    dispatchKeydown('g');
    await new Promise((resolve) => setTimeout(resolve, 60));
    dispatchKeydown('s');
    expect(commands).toEqual([]);
    // And a fresh "g" arms it again.
    dispatchKeydown('g');
    dispatchKeydown('i');
    expect(commands).toEqual(['goto-inbox']);
  });

  test('a re-render between the two keys of a chord keeps the prefix armed', () => {
    const { commands, rerender } = mount();
    dispatchKeydown('g');
    rerender();
    dispatchKeydown('s');
    expect(commands).toEqual(['goto-settings']);
  });

  test('the latest onCommand is the one called after a re-render', () => {
    const first: GlobalKeyCommand[] = [];
    const second: GlobalKeyCommand[] = [];
    const { rerender } = renderHook(
      ({ sink }: { sink: GlobalKeyCommand[] }) =>
        useGlobalKeyboard({ onCommand: (c) => sink.push(c) }),
      { initialProps: { sink: first } }
    );
    rerender({ sink: second });
    dispatchKeydown('c');
    expect(first).toEqual([]);
    expect(second).toEqual(['new-task']);
  });

  test('an open confirm dialog swallows the bare-key shortcuts', () => {
    const { commands } = mount();
    mountOpenDialog();
    for (const key of ['c', '[', '?']) {
      const event = dispatchKeydown(key);
      expect(event.defaultPrevented).toBe(false);
    }
    dispatchKeydown('g');
    dispatchKeydown('s');
    // Escape is the dialog's own to dismiss; the global layer stays out of it too.
    dispatchKeydown('Escape');
    expect(commands).toEqual([]);
  });

  test('a closed dialog (removed from the DOM) no longer counts as open', () => {
    const { commands } = mount();
    const el = mountOpenDialog();
    dispatchKeydown('c');
    expect(commands).toEqual([]);
    el.remove();
    dispatchKeydown('c');
    expect(commands).toEqual(['new-task']);
  });

  // The @dispatch/ui slide-over, command palette and phone drawer mark their panel
  // `aria-modal="true"` while open and unmount on close, as the dialogs do.
  test('an open aria-modal surface swallows the shortcuts like a dialog', () => {
    const { commands } = mount();
    const el = document.createElement('div');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    document.body.appendChild(el);
    for (const key of ['c', 'Escape']) {
      const event = dispatchKeydown(key);
      expect(event.defaultPrevented).toBe(false);
    }
    dispatchKeydown('g');
    dispatchKeydown('s');
    expect(commands).toEqual([]);
    // Unmounted on close, so the shortcuts come straight back.
    el.remove();
    dispatchKeydown('c');
    expect(commands).toEqual(['new-task']);
  });

  // ⌘P over a modal (the quick open itself, the palette, any Dialog) does
  // nothing, but the key is still claimed: a browser would open its print
  // dialog in its place.
  test('⌘P over an aria-modal surface is claimed without opening anything', () => {
    const { commands } = mount();
    const el = mountOpenDialog();
    const press = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        cancelable: true,
        bubbles: true,
      });
      window.dispatchEvent(event);
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(commands).toEqual(['quick-open-blocked']);
    el.remove();
    expect(press().defaultPrevented).toBe(true);
    expect(commands).toEqual(['quick-open-blocked', 'quick-open']);
  });

  // Owner decision 2026-11-03: on macOS only ⌘P is quick open; Ctrl+P there
  // stays with the focused text field (Cocoa's "previous line").
  test('on macOS Ctrl+P is left alone and ⌘P opens quick open', () => {
    const commands: GlobalKeyCommand[] = [];
    renderHook(() =>
      useGlobalKeyboard({
        onCommand: (c) => commands.push(c),
        applePlatform: true,
      })
    );
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const press = (mods: { metaKey?: boolean; ctrlKey?: boolean }) => {
      const event = new KeyboardEvent('keydown', {
        key: 'p',
        cancelable: true,
        bubbles: true,
        ...mods,
      });
      field.dispatchEvent(event);
      return event;
    };
    expect(press({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(commands).toEqual([]);
    expect(press({ metaKey: true }).defaultPrevented).toBe(true);
    expect(commands).toEqual(['quick-open']);
  });

  test('off macOS Ctrl+P opens quick open, from a text field too', () => {
    const commands: GlobalKeyCommand[] = [];
    renderHook(() =>
      useGlobalKeyboard({
        onCommand: (c) => commands.push(c),
        applePlatform: false,
      })
    );
    const field = document.createElement('input');
    document.body.appendChild(field);
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(commands).toEqual(['quick-open']);
  });

  // Settings hides the views under <Activity mode="hidden">, which keeps a dialog
  // open in one in the DOM (aria-modal and all) behind display: none.
  test('a modal surface inside a hidden Activity does not count as open', () => {
    // ActivityProps types children as a prop; they go in as createElement's
    // third argument, as JSX would put them.
    const surface = (mode: 'hidden' | 'visible') =>
      createElement(
        Activity,
        { mode } as ComponentProps<typeof Activity>,
        createElement('div', { role: 'dialog', 'aria-modal': 'true' }, 'kept')
      );
    const { getByRole, rerender } = render(surface('hidden'));
    const dialog = getByRole('dialog', { hidden: true });
    expect(isShown(dialog)).toBe(false);
    expect(isAnyModalOpen()).toBe(false);
    const { commands } = mount();
    dispatchKeydown('Escape');
    expect(commands).toEqual(['escape']);
    // Its view back, the dialog owns the keyboard again.
    rerender(surface('visible'));
    expect(isShown(dialog)).toBe(true);
    expect(isAnyModalOpen()).toBe(true);
    dispatchKeydown('Escape');
    expect(commands).toEqual(['escape']);
  });
});

describe('isTypingTarget', () => {
  // A picker's list is not a text field, but its typeahead owns the letters
  // typed into it, matched or not; a submenu is only role="menu".
  test('focus inside an open picker or menu counts as typing', () => {
    const popup = document.createElement('div');
    popup.setAttribute('data-picker-popup', '');
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    popup.appendChild(list);
    const submenu = document.createElement('div');
    submenu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    submenu.appendChild(item);
    const plain = document.createElement('button');
    document.body.append(popup, submenu, plain);
    expect(isTypingTarget(list)).toBe(true);
    expect(isTypingTarget(item)).toBe(true);
    expect(isTypingTarget(plain)).toBe(false);
    // A letter typed in the open list never reaches a shortcut.
    const { commands } = mount();
    list.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        bubbles: true,
        cancelable: true,
      })
    );
    plain.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        bubbles: true,
        cancelable: true,
      })
    );
    expect(commands).toEqual(['new-task']);
  });

  // A ticked review criterion keeps focus on its checkbox, which takes no letters: the
  // app's bare keys still work from it, while a text input keeps them.
  test('a checkbox or button input is not typing; a text input is', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    const press = document.createElement('input');
    press.type = 'button';
    const text = document.createElement('input');
    text.type = 'text';
    document.body.append(box, press, text);
    expect(isTypingTarget(box)).toBe(false);
    expect(isTypingTarget(press)).toBe(false);
    expect(isTypingTarget(text)).toBe(true);
    const { commands } = mount();
    for (const target of [box, text]) {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          bubbles: true,
          cancelable: true,
        })
      );
    }
    expect(commands).toEqual(['new-task']);
    box.remove();
    press.remove();
    text.remove();
  });
});

describe('isApplePlatform', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'platform', original);
    else Reflect.deleteProperty(navigator, 'platform');
  });

  function stubPlatform(platform: string) {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      get: () => platform,
    });
  }

  test.each([
    ['MacIntel', true],
    ['iPad', true],
    ['Win32', false],
    ['Linux x86_64', false],
  ] as const)('%p is Apple: %p', (platform, expected) => {
    stubPlatform(platform);
    expect(isApplePlatform()).toBe(expected);
  });
});
