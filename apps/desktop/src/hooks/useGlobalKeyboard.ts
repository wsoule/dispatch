import { useEffect } from 'react';

import type { KeyCommand } from '../lib/keyboard';
import { resolveKeyCommand } from '../lib/keyboard';

/** True while the event's target is a text field — the DOM-touching half of
 * `KeyboardContext.isTyping` that `lib/keyboard.ts` itself stays pure of. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

interface UseGlobalKeyboardOptions {
  paletteOpen: boolean;
  peekOpen: boolean;
  onCommand: (command: KeyCommand) => void;
}

/** Wires `resolveKeyCommand` to a real `keydown` listener on the window — the one place in
 * the app that touches the DOM for this; every actual decision lives in the pure resolver so
 * it stays unit-testable on its own. Mount once near the app root. */
export function useGlobalKeyboard({
  paletteOpen,
  peekOpen,
  onCommand,
}: UseGlobalKeyboardOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const command = resolveKeyCommand(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        {
          isTyping: isTypingTarget(event.target),
          paletteOpen,
          peekOpen,
        }
      );
      if (command === null) return;
      // Every resolved command owns the keystroke — cmd+k in particular must not also type a
      // literal "k" into whatever's focused, and "/" must not land in a text field either.
      event.preventDefault();
      onCommand(command);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [paletteOpen, peekOpen, onCommand]);
}
