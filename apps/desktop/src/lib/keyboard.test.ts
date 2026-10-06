import { describe, expect, test } from 'bun:test';

import type {
  GitKeyboardContext,
  GlobalKeyboardContext,
  KeyInput,
  ListKeyboardContext,
} from './keyboard';
import {
  isInteractiveControlTagName,
  isTypingTagName,
  resolveCardKeyAction,
  resolveChordPrefix,
  resolveGitKeyCommand,
  resolveGlobalKeyCommand,
  resolveListKeyCommand,
} from './keyboard';

const baseGlobalCtx: GlobalKeyboardContext = {
  isTyping: false,
  modalOpen: false,
  pendingPrefix: null,
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

  test('bare "c" opens the task creator, but never while typing or over a modal', () => {
    // Bare, not ⌘C — copy keeps its modifier, so the two never meet.
    expect(resolveGlobalKeyCommand(key('c'), baseGlobalCtx)).toBe('new-task');
    expect(
      resolveGlobalKeyCommand(key('c'), { ...baseGlobalCtx, isTyping: true })
    ).toBeNull();
    expect(
      resolveGlobalKeyCommand(key('c'), { ...baseGlobalCtx, modalOpen: true })
    ).toBeNull();
    expect(
      resolveGlobalKeyCommand(key('c', { metaKey: true }), baseGlobalCtx)
    ).toBeNull();
  });

  test('bare "[" toggles the sidebar; ⌘[ is still history', () => {
    expect(resolveGlobalKeyCommand(key('['), baseGlobalCtx)).toBe(
      'toggle-sidebar'
    );
    expect(
      resolveGlobalKeyCommand(key('[', { metaKey: true }), baseGlobalCtx)
    ).toBe('nav-back');
    expect(
      resolveGlobalKeyCommand(key('['), { ...baseGlobalCtx, isTyping: true })
    ).toBeNull();
    expect(
      resolveGlobalKeyCommand(key('['), { ...baseGlobalCtx, modalOpen: true })
    ).toBeNull();
  });

  test('"?" opens the shortcuts reference outside text fields', () => {
    expect(resolveGlobalKeyCommand(key('?'), baseGlobalCtx)).toBe(
      'open-shortcuts'
    );
    expect(
      resolveGlobalKeyCommand(key('?'), { ...baseGlobalCtx, isTyping: true })
    ).toBeNull();
  });

  test('a bare "g" arms the chord prefix instead of resolving', () => {
    expect(resolveGlobalKeyCommand(key('g'), baseGlobalCtx)).toBeNull();
    expect(resolveChordPrefix(key('g'), baseGlobalCtx)).toBe('g');
    // Not while typing, not over a modal, not with a modifier, not twice.
    expect(
      resolveChordPrefix(key('g'), { ...baseGlobalCtx, isTyping: true })
    ).toBeNull();
    expect(
      resolveChordPrefix(key('g'), { ...baseGlobalCtx, modalOpen: true })
    ).toBeNull();
    expect(
      resolveChordPrefix(key('g', { metaKey: true }), baseGlobalCtx)
    ).toBeNull();
    expect(
      resolveChordPrefix(key('g'), { ...baseGlobalCtx, pendingPrefix: 'g' })
    ).toBeNull();
    expect(resolveChordPrefix(key('h'), baseGlobalCtx)).toBeNull();
  });

  test('with "g" armed the second key resolves the chord', () => {
    const armed = { ...baseGlobalCtx, pendingPrefix: 'g' as const };
    expect(resolveGlobalKeyCommand(key('s'), armed)).toBe('goto-settings');
    expect(resolveGlobalKeyCommand(key('i'), armed)).toBe('goto-inbox');
    expect(resolveGlobalKeyCommand(key('t'), armed)).toBe('goto-tasks');
    expect(resolveGlobalKeyCommand(key('r'), armed)).toBe('goto-projects');
    expect(resolveGlobalKeyCommand(key('f'), armed)).toBe('goto-live');
    expect(resolveGlobalKeyCommand(key('c'), armed)).toBe('goto-control-room');
    expect(resolveGlobalKeyCommand(key('a'), armed)).toBe('goto-overseer');
    expect(resolveGlobalKeyCommand(key('m'), armed)).toBe('goto-threads');
    // A miss is nothing — not the key's own bare meaning.
    expect(resolveGlobalKeyCommand(key('['), armed)).toBeNull();
    expect(resolveGlobalKeyCommand(key('z'), armed)).toBeNull();
    // Modifier chords still win over an armed prefix.
    expect(resolveGlobalKeyCommand(key('k', { metaKey: true }), armed)).toBe(
      'open-palette'
    );
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

  test('⌘= / ⌘+ / ⌘- / ⌘0 resolve to zoom commands, even while typing', () => {
    const typing = { ...baseGlobalCtx, isTyping: true };
    expect(resolveGlobalKeyCommand(key('=', { metaKey: true }), typing)).toBe(
      'zoom-in'
    );
    expect(resolveGlobalKeyCommand(key('+', { metaKey: true }), typing)).toBe(
      'zoom-in'
    );
    expect(resolveGlobalKeyCommand(key('-', { metaKey: true }), typing)).toBe(
      'zoom-out'
    );
    expect(resolveGlobalKeyCommand(key('0', { metaKey: true }), typing)).toBe(
      'zoom-reset'
    );
    // Bare keys stay ordinary typing.
    expect(resolveGlobalKeyCommand(key('-'), baseGlobalCtx)).toBeNull();
    expect(resolveGlobalKeyCommand(key('0'), baseGlobalCtx)).toBeNull();
  });

  test('⌘D opens the brain dump, but never while typing or over a modal', () => {
    expect(
      resolveGlobalKeyCommand(key('d', { metaKey: true }), baseGlobalCtx)
    ).toBe('brain-dump');
    expect(
      resolveGlobalKeyCommand(key('D', { ctrlKey: true }), baseGlobalCtx)
    ).toBe('brain-dump');
    expect(
      resolveGlobalKeyCommand(key('d', { metaKey: true }), {
        ...baseGlobalCtx,
        isTyping: true,
      })
    ).toBeNull();
    expect(
      resolveGlobalKeyCommand(key('d', { metaKey: true }), {
        ...baseGlobalCtx,
        modalOpen: true,
      })
    ).toBeNull();
    expect(resolveGlobalKeyCommand(key('d'), baseGlobalCtx)).toBeNull();
  });

  test('⌘B aliases the sidebar toggle with the same typing and modal guards', () => {
    expect(
      resolveGlobalKeyCommand(key('b', { metaKey: true }), baseGlobalCtx)
    ).toBe('toggle-sidebar');
    expect(
      resolveGlobalKeyCommand(key('B', { ctrlKey: true }), baseGlobalCtx)
    ).toBe('toggle-sidebar');
    expect(
      resolveGlobalKeyCommand(key('b', { metaKey: true }), {
        ...baseGlobalCtx,
        isTyping: true,
      })
    ).toBeNull();
    expect(
      resolveGlobalKeyCommand(key('b', { metaKey: true }), {
        ...baseGlobalCtx,
        modalOpen: true,
      })
    ).toBeNull();
    // A bare "b" is ordinary typing.
    expect(resolveGlobalKeyCommand(key('b'), baseGlobalCtx)).toBeNull();
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

  test('the arrow keys alias j/k', () => {
    expect(resolveListKeyCommand(key('ArrowDown'), baseListCtx)).toBe(
      'list-down'
    );
    expect(resolveListKeyCommand(key('ArrowUp'), baseListCtx)).toBe('list-up');
  });

  test('o opens, Space peeks, x toggles selection, Escape clears it', () => {
    expect(resolveListKeyCommand(key('o'), baseListCtx)).toBe('list-open');
    expect(resolveListKeyCommand(key(' '), baseListCtx)).toBe('list-peek');
    expect(resolveListKeyCommand(key('x'), baseListCtx)).toBe(
      'list-select-toggle'
    );
    expect(resolveListKeyCommand(key('Escape'), baseListCtx)).toBe(
      'list-escape'
    );
  });

  test('the single-key property shortcuts', () => {
    expect(resolveListKeyCommand(key('s'), baseListCtx)).toBe(
      'list-set-status'
    );
    expect(resolveListKeyCommand(key('p'), baseListCtx)).toBe(
      'list-set-priority'
    );
    expect(resolveListKeyCommand(key('a'), baseListCtx)).toBe(
      'list-set-assignee'
    );
    expect(resolveListKeyCommand(key('l'), baseListCtx)).toBe(
      'list-set-labels'
    );
    expect(resolveListKeyCommand(key('e'), baseListCtx)).toBe('list-set-epic');
    expect(resolveListKeyCommand(key('m'), baseListCtx)).toBe(
      'list-set-milestone'
    );
    expect(resolveListKeyCommand(key('d'), baseListCtx)).toBe('list-dispatch');
    expect(resolveListKeyCommand(key('f'), baseListCtx)).toBe(
      'list-open-filter'
    );
    // ⇧V arrives as the uppercase key; a bare `v` is nothing.
    expect(resolveListKeyCommand(key('V'), baseListCtx)).toBe(
      'list-open-display'
    );
    expect(resolveListKeyCommand(key('v'), baseListCtx)).toBeNull();
  });

  test('nothing resolves while typing', () => {
    const typing = { ...baseListCtx, isTyping: true };
    for (const k of ['s', 'x', 'o', ' ', 'f', 'ArrowDown', 'Escape']) {
      expect(resolveListKeyCommand(key(k), typing)).toBeNull();
    }
  });

  test('does not resolve global-only commands', () => {
    expect(resolveListKeyCommand(key('/'), baseListCtx)).toBeNull();
    expect(resolveListKeyCommand(key('c'), baseListCtx)).toBeNull();
    expect(resolveListKeyCommand(key('['), baseListCtx)).toBeNull();
    expect(
      resolveListKeyCommand(key('k', { metaKey: true }), baseListCtx)
    ).toBeNull();
  });

  test('unrelated keys resolve to null', () => {
    expect(resolveListKeyCommand(key('q'), baseListCtx)).toBeNull();
    expect(resolveListKeyCommand(key('Tab'), baseListCtx)).toBeNull();
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

describe('navigation shortcuts', () => {
  const ctx = baseGlobalCtx;
  const typing = { ...baseGlobalCtx, isTyping: true };

  test('cmd+[ and cmd+] move through history', () => {
    expect(
      resolveGlobalKeyCommand({ key: '[', metaKey: true, ctrlKey: false }, ctx)
    ).toBe('nav-back');
    expect(
      resolveGlobalKeyCommand({ key: ']', metaKey: true, ctrlKey: false }, ctx)
    ).toBe('nav-forward');
  });

  test('cmd+N jumps to a rail entry', () => {
    expect(
      resolveGlobalKeyCommand({ key: '3', metaKey: true, ctrlKey: false }, ctx)
    ).toBe('goto-3');
  });

  test('modified shortcuts still fire while typing', () => {
    // Being unable to leave a screen because the cursor is in a filter box is
    // the kind of thing that makes an app feel stuck.
    expect(
      resolveGlobalKeyCommand(
        { key: '2', metaKey: true, ctrlKey: false },
        typing
      )
    ).toBe('goto-2');
    expect(
      resolveGlobalKeyCommand(
        { key: '[', metaKey: true, ctrlKey: false },
        typing
      )
    ).toBe('nav-back');
  });

  test('a bare digit is still just a digit', () => {
    expect(
      resolveGlobalKeyCommand({ key: '3', metaKey: false, ctrlKey: false }, ctx)
    ).toBeNull();
  });
});

const baseGitCtx: GitKeyboardContext = { isTyping: false };

describe('resolveGitKeyCommand', () => {
  test('bare digits 1-5 focus the matching panel', () => {
    expect(resolveGitKeyCommand(key('1'), baseGitCtx)).toEqual({
      kind: 'focus-panel',
      panel: 'status',
    });
    expect(resolveGitKeyCommand(key('2'), baseGitCtx)).toEqual({
      kind: 'focus-panel',
      panel: 'files',
    });
    expect(resolveGitKeyCommand(key('5'), baseGitCtx)).toEqual({
      kind: 'focus-panel',
      panel: 'stashes',
    });
  });

  test('j/k move the selection, space toggles stage', () => {
    expect(resolveGitKeyCommand(key('j'), baseGitCtx)).toEqual({
      kind: 'move',
      delta: 1,
    });
    expect(resolveGitKeyCommand(key('k'), baseGitCtx)).toEqual({
      kind: 'move',
      delta: -1,
    });
    expect(resolveGitKeyCommand(key(' '), baseGitCtx)).toEqual({
      kind: 'toggle-stage',
    });
  });

  test('shifted letters resolve to a different command than their lowercase form', () => {
    expect(resolveGitKeyCommand(key('a'), baseGitCtx)).toEqual({
      kind: 'stage-all',
    });
    expect(resolveGitKeyCommand(key('A'), baseGitCtx)).toEqual({
      kind: 'amend',
    });
    expect(resolveGitKeyCommand(key('s'), baseGitCtx)).toEqual({
      kind: 'stash',
    });
    expect(resolveGitKeyCommand(key('S'), baseGitCtx)).toEqual({
      kind: 'stash-pop',
    });
    expect(resolveGitKeyCommand(key('p'), baseGitCtx)).toEqual({
      kind: 'pull',
    });
    expect(resolveGitKeyCommand(key('P'), baseGitCtx)).toEqual({
      kind: 'push',
    });
  });

  test('remaining single-letter and symbol commands', () => {
    expect(resolveGitKeyCommand(key('c'), baseGitCtx)).toEqual({
      kind: 'commit',
    });
    expect(resolveGitKeyCommand(key('d'), baseGitCtx)).toEqual({
      kind: 'discard',
    });
    expect(resolveGitKeyCommand(key('b'), baseGitCtx)).toEqual({
      kind: 'new-branch',
    });
    expect(resolveGitKeyCommand(key('Enter'), baseGitCtx)).toEqual({
      kind: 'checkout',
    });
    expect(resolveGitKeyCommand(key('f'), baseGitCtx)).toEqual({
      kind: 'fetch',
    });
    expect(resolveGitKeyCommand(key('/'), baseGitCtx)).toEqual({
      kind: 'filter',
    });
    expect(resolveGitKeyCommand(key('?'), baseGitCtx)).toEqual({
      kind: 'help',
    });
  });

  test('nothing resolves while typing, except nothing is exempted (unlike the global layer)', () => {
    const typing = { isTyping: true };
    expect(resolveGitKeyCommand(key('1'), typing)).toBeNull();
    expect(resolveGitKeyCommand(key('j'), typing)).toBeNull();
    expect(resolveGitKeyCommand(key('?'), typing)).toBeNull();
  });

  test('a held modifier never resolves a Git page command', () => {
    expect(
      resolveGitKeyCommand(key('j', { metaKey: true }), baseGitCtx)
    ).toBeNull();
    expect(
      resolveGitKeyCommand(key('1', { ctrlKey: true }), baseGitCtx)
    ).toBeNull();
  });

  test('unrelated keys resolve to null', () => {
    expect(resolveGitKeyCommand(key('x'), baseGitCtx)).toBeNull();
    expect(resolveGitKeyCommand(key('Tab'), baseGitCtx)).toBeNull();
  });
});

describe('Two views shortcuts', () => {
  test('⌘, opens Settings, even while typing', () => {
    expect(
      resolveGlobalKeyCommand(key(',', { metaKey: true }), baseGlobalCtx)
    ).toBe('goto-settings');
    expect(
      resolveGlobalKeyCommand(key(',', { metaKey: true }), {
        ...baseGlobalCtx,
        isTyping: true,
      })
    ).toBe('goto-settings');
  });

  test('g o goes to Overseer, like g a', () => {
    const armed = { ...baseGlobalCtx, pendingPrefix: 'g' as const };
    expect(resolveGlobalKeyCommand(key('o'), armed)).toBe('goto-overseer');
  });
});
