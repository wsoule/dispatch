import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import type { GlobalKeyCommand } from '../lib/keyboard';
import { useGlobalKeyboard } from './useGlobalKeyboard';

// Fires a real `keydown` on `window`, optionally pre-cancelled the way a Base UI popup
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

// Stands in for an open Base UI `Dialog.Popup`: `@/ui/dialog` stamps `data-slot`, Base UI
// stamps the bare `data-open` while it is open.
function mountOpenDialog(slot = 'dialog-content') {
  const el = document.createElement('div');
  el.setAttribute('data-slot', slot);
  el.setAttribute('data-open', '');
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

  test('an Escape a Base UI popup already defaultPrevented never reaches onCommand', () => {
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

  test('an open Base UI dialog swallows the bare-key shortcuts', () => {
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

  test('an open alert dialog swallows the shortcuts the same way', () => {
    const { commands } = mount();
    mountOpenDialog('alert-dialog-content');
    dispatchKeydown('c');
    expect(commands).toEqual([]);
  });

  test('a dialog mid exit-animation (data-closed) no longer counts as open', () => {
    const { commands } = mount();
    const el = mountOpenDialog();
    el.removeAttribute('data-open');
    el.setAttribute('data-closed', '');
    dispatchKeydown('c');
    expect(commands).toEqual(['new-task']);
  });
});
