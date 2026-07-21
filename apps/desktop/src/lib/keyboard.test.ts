import { describe, expect, test } from 'bun:test';

import type {
  GlobalKeyboardContext,
  KeyInput,
  ListKeyboardContext,
} from './keyboard';
import { resolveGlobalKeyCommand, resolveListKeyCommand } from './keyboard';

const baseGlobalCtx: GlobalKeyboardContext = {
  isTyping: false,
  modalOpen: false,
};

function key(k: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { key: k, metaKey: false, ctrlKey: false, ...mods };
}

describe('resolveGlobalKeyCommand', () => {
  test('Escape resolves when no modal is open, even while typing', () => {
    expect(resolveGlobalKeyCommand(key('Escape'), baseGlobalCtx)).toBe(
      'escape'
    );
    expect(
      resolveGlobalKeyCommand(key('Escape'), {
        ...baseGlobalCtx,
        isTyping: true,
      })
    ).toBe('escape');
  });

  test('Escape is suppressed at the global layer while a modal is open', () => {
    // A Modal owns its own Escape listener — the global layer must stay out of the way so a
    // single Escape press doesn't also close whatever's stacked behind the modal (e.g. the
    // task peek panel).
    expect(
      resolveGlobalKeyCommand(key('Escape'), {
        ...baseGlobalCtx,
        modalOpen: true,
      })
    ).toBeNull();
  });

  test('cmd+k and ctrl+k open the palette regardless of typing state', () => {
    expect(
      resolveGlobalKeyCommand(key('k', { metaKey: true }), baseGlobalCtx)
    ).toBe('open-palette');
    expect(
      resolveGlobalKeyCommand(key('K', { ctrlKey: true }), baseGlobalCtx)
    ).toBe('open-palette');
    expect(
      resolveGlobalKeyCommand(key('k', { metaKey: true }), {
        ...baseGlobalCtx,
        isTyping: true,
      })
    ).toBe('open-palette');
  });

  test('bare "/" opens the palette only when not typing', () => {
    expect(resolveGlobalKeyCommand(key('/'), baseGlobalCtx)).toBe(
      'open-palette'
    );
    expect(
      resolveGlobalKeyCommand(key('/'), { ...baseGlobalCtx, isTyping: true })
    ).toBeNull();
  });

  test('"c" starts a new task only when not typing', () => {
    expect(resolveGlobalKeyCommand(key('c'), baseGlobalCtx)).toBe('new-task');
    expect(
      resolveGlobalKeyCommand(key('c'), { ...baseGlobalCtx, isTyping: true })
    ).toBeNull();
  });

  test('bare Enter outside text fields resolves to null globally (C2)', () => {
    // Enter must never be intercepted at the root — it has to keep reaching whatever button
    // or form the page actually has focused. List confirmation is a per-view local concern
    // (see resolveListKeyCommand), never a global one.
    expect(resolveGlobalKeyCommand(key('Enter'), baseGlobalCtx)).toBeNull();
    expect(
      resolveGlobalKeyCommand(key('Enter'), {
        ...baseGlobalCtx,
        isTyping: true,
      })
    ).toBeNull();
  });

  test('j/k never resolve at the global layer', () => {
    expect(resolveGlobalKeyCommand(key('j'), baseGlobalCtx)).toBeNull();
    expect(resolveGlobalKeyCommand(key('k'), baseGlobalCtx)).toBeNull();
  });

  test('unrelated keys resolve to null', () => {
    expect(resolveGlobalKeyCommand(key('a'), baseGlobalCtx)).toBeNull();
    expect(resolveGlobalKeyCommand(key('Tab'), baseGlobalCtx)).toBeNull();
  });
});

const baseListCtx: ListKeyboardContext = { isTyping: false };

describe('resolveListKeyCommand', () => {
  test('j/k/Enter drive list navigation only when not typing', () => {
    expect(resolveListKeyCommand(key('j'), baseListCtx)).toBe('list-down');
    expect(resolveListKeyCommand(key('k'), baseListCtx)).toBe('list-up');
    expect(resolveListKeyCommand(key('Enter'), baseListCtx)).toBe(
      'list-confirm'
    );
    expect(
      resolveListKeyCommand(key('j'), { ...baseListCtx, isTyping: true })
    ).toBeNull();
    expect(
      resolveListKeyCommand(key('Enter'), { ...baseListCtx, isTyping: true })
    ).toBeNull();
  });

  test('does not resolve global-only commands', () => {
    expect(resolveListKeyCommand(key('Escape'), baseListCtx)).toBeNull();
    expect(resolveListKeyCommand(key('/'), baseListCtx)).toBeNull();
    expect(resolveListKeyCommand(key('c'), baseListCtx)).toBeNull();
    expect(
      resolveListKeyCommand(key('k', { metaKey: true }), baseListCtx)
    ).toBeNull();
  });

  test('unrelated keys resolve to null', () => {
    expect(resolveListKeyCommand(key('a'), baseListCtx)).toBeNull();
  });
});
