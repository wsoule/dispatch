import { useEffect } from 'react';

import type { GlobalKeyCommand } from '../lib/keyboard';
import { isTypingTagName, resolveGlobalKeyCommand } from '../lib/keyboard';

/** True while the event's target is a text field — the DOM-touching half of
 * `GlobalKeyboardContext.isTyping` that `lib/keyboard.ts` itself stays pure of. Exported so
 * any other keydown-listening container that also holds real form controls (e.g. `BoardView`'s
 * roving-focus track, which wraps an epic card's concurrency `<input>`) can build its own
 * `isTyping` the same way instead of hardcoding `false`. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return isTypingTagName(target.tagName, target.isContentEditable);
}

/** True while any `Modal`-based dialog (see `components/ui/Modal.tsx`'s `data-modal="true"`
 * marker) is currently mounted. Checked live via a DOM query at the moment a keydown fires,
 * rather than threaded through as reactive React state — every `Modal` instance (
 * CreateTaskModal, SessionDetailModal, DiffModal, …) already only renders into the DOM while
 * open, so the query itself is always exactly as current as the state would be, without
 * App.tsx needing to know about every modal that exists anywhere in the component tree
 * (including ones mounted deep inside the Sessions hub, which App.tsx has no direct view
 * into). Excludes the command palette on purpose — see Modal.tsx's doc comment on
 * `data-modal`. */
function isAnyModalOpen(): boolean {
  return document.querySelector('[data-modal="true"]') !== null;
}

interface UseGlobalKeyboardOptions {
  onCommand: (command: GlobalKeyCommand) => void;
}

/** Wires `resolveGlobalKeyCommand` to a real `keydown` listener on the window — the one place
 * in the app that touches the DOM for this; every actual decision lives in the pure resolver
 * so it stays unit-testable on its own. Mount once near the app root. Deliberately never
 * resolves (or `preventDefault`s) list-navigation keys — those belong to whichever list view
 * has focus, resolved locally via `resolveListKeyCommand`, so this listener never swallows an
 * Enter/j/k meant for a button, form, or text field elsewhere on the page. */
export function useGlobalKeyboard({
  onCommand,
}: UseGlobalKeyboardOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const command = resolveGlobalKeyCommand(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        { isTyping: isTypingTarget(event.target), modalOpen: isAnyModalOpen() }
      );
      if (command === null) return;
      // Every resolved command owns the keystroke — cmd+k in particular must not also type a
      // literal "k" into whatever's focused, and "/" must not land in a text field either.
      // Only commands the root layer actually resolves ever reach this point, so this never
      // suppresses a keystroke the root doesn't own (see C2 in the phase-8 fix report).
      event.preventDefault();
      onCommand(command);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCommand]);
}
