import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { GlobalKeyCommand } from '../lib/keyboard';
import { useGlobalKeyboard } from './useGlobalKeyboard';

// Fires a real `keydown` on `window`, optionally pre-cancelled the way Radix's dismissable
// layer cancels Escape when it closes a Select/DropdownMenu popper — before this listener
// ever sees the event, not as a side effect of it.
function dispatchKeydown(key: string, { defaultPrevented = false } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    bubbles: true,
  });
  if (defaultPrevented) event.preventDefault();
  window.dispatchEvent(event);
}

describe('useGlobalKeyboard', () => {
  test('a plain Escape resolves to a command', () => {
    const commands: GlobalKeyCommand[] = [];
    renderHook(() => useGlobalKeyboard({ onCommand: (c) => commands.push(c) }));
    dispatchKeydown('Escape');
    expect(commands).toEqual(['escape']);
  });

  test('an Escape a Radix popper already defaultPrevented never reaches onCommand', () => {
    const commands: GlobalKeyCommand[] = [];
    renderHook(() => useGlobalKeyboard({ onCommand: (c) => commands.push(c) }));
    dispatchKeydown('Escape', { defaultPrevented: true });
    expect(commands).toEqual([]);
  });
});
