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

/** True while any dialog is currently open — either a legacy `Modal` (see
 * `components/ui/Modal.tsx`'s `data-modal="true"` marker) or a shadcn/Radix `Dialog`
 * (`@/ui/dialog`'s `DialogContent` renders with `data-slot="dialog-content"`, and Radix keeps
 * `data-state="open"` on it only while open — briefly `"closed"` during its exit animation, so
 * that state is checked too rather than just presence in the DOM). `AlertDialogContent` is the
 * same device under a different slot name (`data-slot="alert-dialog-content"`), so it is matched
 * too — a destructive confirm has to swallow the app's shortcuts exactly like any other modal
 * does (BranchesView's confirm is one). Checked live via a DOM
 * query at the moment a keydown fires, rather than threaded through as reactive React state —
 * every dialog instance (CreateTaskModal, SessionDetailModal, DiffModal, CommandPalette, …)
 * already only renders into the DOM while open, so the query itself is always exactly as
 * current as the state would be, without App.tsx needing to know about every modal that exists
 * anywhere in the component tree (including ones mounted deep inside the Sessions hub, which
 * App.tsx has no direct view into). CommandPalette is one of these now that it builds on
 * `Dialog` too, so a keydown reaching this listener while the palette is open resolves
 * `Escape` to `null` here — Radix's own Escape handling on `Dialog` already owns it, and
 * `CommandPalette`'s `onClose` prop is the only thing that closes it (see `appNav.ts`'s
 * `closePalette` case). */
function isAnyModalOpen(): boolean {
  return (
    document.querySelector(
      '[data-modal="true"], [data-slot="dialog-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"]'
    ) !== null
  );
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
      // A Radix dismissable layer (Select/DropdownMenu popper) already preventDefaults Escape
      // when it closes itself — without this guard the window-level listener below still saw
      // the same keystroke and dispatched a second, unwanted "back" navigation on top of it.
      if (event.defaultPrevented) return;
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
