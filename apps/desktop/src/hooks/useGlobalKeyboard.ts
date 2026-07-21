import { useEffect } from 'react';

import type { GlobalKeyCommand } from '../lib/keyboard';
import { resolveGlobalKeyCommand } from '../lib/keyboard';

/** True while the event's target is a text field — the DOM-touching half of
 * `GlobalKeyboardContext.isTyping` that `lib/keyboard.ts` itself stays pure of. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

interface UseGlobalKeyboardOptions {
  /** Whether a `Modal`-based dialog is currently open — see
   * `GlobalKeyboardContext.modalOpen`'s doc comment for why Escape must be suppressed here
   * rather than also firing the app's own `escape` nav action while one is open. */
  modalOpen: boolean;
  onCommand: (command: GlobalKeyCommand) => void;
}

/** Wires `resolveGlobalKeyCommand` to a real `keydown` listener on the window — the one place
 * in the app that touches the DOM for this; every actual decision lives in the pure resolver
 * so it stays unit-testable on its own. Mount once near the app root. Deliberately never
 * resolves (or `preventDefault`s) list-navigation keys — those belong to whichever list view
 * has focus, resolved locally via `resolveListKeyCommand`, so this listener never swallows an
 * Enter/j/k meant for a button, form, or text field elsewhere on the page. */
export function useGlobalKeyboard({
  modalOpen,
  onCommand,
}: UseGlobalKeyboardOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const command = resolveGlobalKeyCommand(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        { isTyping: isTypingTarget(event.target), modalOpen }
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
  }, [modalOpen, onCommand]);
}
