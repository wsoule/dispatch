import { describe, expect, test } from 'bun:test';

import type {
  GlobalKeyboardContext,
  KeyInput,
  ListKeyboardContext,
} from './keyboard';
import {
  isInteractiveControlTagName,
  isTypingTagName,
  resolveCardKeyAction,
  resolveGlobalKeyCommand,
  resolveListKeyCommand,
} from './keyboard';

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

describe('isTypingTagName', () => {
  // The board's roving-focus track handler used to hardcode `isTyping: false`, so j/k typed
  // into the epic card's concurrency <input> (nested inside the board's keydown-listening
  // track) navigated the board instead of editing the field. This is the pure decision
  // `isTypingTarget` (hooks/useGlobalKeyboard.ts) delegates to once it has pulled a tag name
  // and contenteditable flag off a real DOM node — kept separate so the actual logic is
  // testable without a DOM.
  test('is true for INPUT and TEXTAREA tag names', () => {
    expect(isTypingTagName('INPUT', false)).toBe(true);
    expect(isTypingTagName('TEXTAREA', false)).toBe(true);
  });

  test('is true for any contenteditable element regardless of tag name', () => {
    expect(isTypingTagName('DIV', true)).toBe(true);
  });

  test('is false for a plain button or div', () => {
    expect(isTypingTagName('BUTTON', false)).toBe(false);
    expect(isTypingTagName('DIV', false)).toBe(false);
  });
});

describe('isInteractiveControlTagName', () => {
  // The Board track wraps an epic card's Work/Stop <button>s and a card's inline
  // "Dispatch →" button. A keydown on one of those must NOT be hijacked for board
  // navigation — Enter should activate the button. Cards themselves are role="button"
  // DIVs, so they must fall through (return false) to keep j/k/Enter roving navigation.
  test('is true for click-style and form controls', () => {
    for (const tag of ['BUTTON', 'A', 'SELECT', 'INPUT', 'TEXTAREA']) {
      expect(isInteractiveControlTagName(tag)).toBe(true);
    }
  });

  test('is false for a card DIV (role=button) and other non-controls', () => {
    expect(isInteractiveControlTagName('DIV')).toBe(false);
    expect(isInteractiveControlTagName('SPAN')).toBe(false);
  });
});

describe('resolveCardKeyAction', () => {
  // A Board card (TaskCardTile) wraps its inline "Dispatch →" button — a native keydown on
  // that button still bubbles up through the card's own onKeyDown. Without this guard,
  // pressing Enter/Space to activate the button also opened the card's peek panel.
  test('activates on Enter/Space when the keydown originated directly on the card', () => {
    expect(resolveCardKeyAction('Enter', true)).toBe('activate');
    expect(resolveCardKeyAction(' ', true)).toBe('activate');
  });

  test('a keydown bubbled up from a nested interactive child never activates the card', () => {
    expect(resolveCardKeyAction('Enter', false)).toBeNull();
    expect(resolveCardKeyAction(' ', false)).toBeNull();
  });

  test('unrelated keys never activate, even directly on the card', () => {
    expect(resolveCardKeyAction('a', true)).toBeNull();
    expect(resolveCardKeyAction('Tab', true)).toBeNull();
  });
});
