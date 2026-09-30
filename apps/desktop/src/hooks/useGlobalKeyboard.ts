import { useEffect, useRef } from 'react';

import type { ChordPrefix, GlobalKeyCommand } from '../lib/keyboard';
import {
  isTypingTagName,
  resolveChordKey,
  resolveChordPrefix,
  resolveGlobalKeyCommand,
} from '../lib/keyboard';

/** True while the event's target is a text field — the DOM-touching half of
 * `GlobalKeyboardContext.isTyping` that `lib/keyboard.ts` itself stays pure of. Exported so
 * any other keydown-listening container that also holds real form controls (e.g. `BoardView`'s
 * roving-focus track, which wraps an epic card's concurrency `<input>`) can build its own
 * `isTyping` the same way instead of hardcoding `false`. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return isTypingTagName(target.tagName, target.isContentEditable);
}

/** True while any dialog is currently open. Every dialog builds on Base UI (`@/ui/dialog`'s
 * `DialogContent` renders `data-slot="dialog-content"`, and `Dialog.Popup` carries a bare
 * `data-open` attribute only while open — it flips to `data-closed` for the exit animation, so
 * presence in the DOM alone is not enough). `AlertDialogContent` is the same device under
 * `data-slot="alert-dialog-content"`, so it is matched too — a destructive confirm has to
 * swallow the app's shortcuts exactly like any other modal does (BranchesView's confirm is
 * one). Checked live via a DOM query at the moment a keydown fires, rather than threaded
 * through as reactive React state — every dialog instance (CreateTaskModal,
 * SessionDetailModal, DiffModal, CommandPalette, …) only renders into the DOM while open, so
 * the query is always exactly as current as the state would be, without App.tsx needing to
 * know about every modal that exists anywhere in the component tree (including ones mounted
 * deep inside the Sessions hub). CommandPalette is one of these too, so a keydown reaching
 * this listener while the palette is open resolves `Escape` to `null` here — Base UI's own
 * dismiss handling on `Dialog` already owns it, and `CommandPalette`'s `onClose` prop is the
 * only thing that closes it (see `appNav.ts`'s `closePalette` case). */
function isAnyModalOpen(): boolean {
  return (
    document.querySelector(
      '[data-slot="dialog-content"][data-open], [data-slot="alert-dialog-content"][data-open]'
    ) !== null
  );
}

/** How long an armed chord prefix (`g`) waits for its second key. */
const CHORD_PREFIX_TIMEOUT_MS = 600;

interface UseGlobalKeyboardOptions {
  onCommand: (command: GlobalKeyCommand) => void;
  /** Overrides the 600ms chord window — tests only. */
  prefixTimeoutMs?: number;
}

/** Wires `resolveGlobalKeyCommand` to a real `keydown` listener on the window — the one place
 * in the app that touches the DOM for this; every actual decision lives in the pure resolver
 * so it stays unit-testable on its own. Mount once near the app root. Deliberately never
 * resolves (or `preventDefault`s) list-navigation keys — those belong to whichever list view
 * has focus, resolved locally via `resolveListKeyCommand`, so this listener never swallows an
 * Enter/j/k meant for a button, form, or text field elsewhere on the page.
 *
 * Also holds the `g` chord state: a bare `g` arms a prefix for `CHORD_PREFIX_TIMEOUT_MS`, and
 * the next keystroke either completes the chord or drops it — the prefix never outlives one
 * keystroke, so a stray `g` can't change what a later letter means. */
export function useGlobalKeyboard({
  onCommand,
  prefixTimeoutMs = CHORD_PREFIX_TIMEOUT_MS,
}: UseGlobalKeyboardOptions): void {
  const pendingPrefix = useRef<ChordPrefix | null>(null);
  const prefixTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // App passes an inline `onCommand`, so the listener reads the latest one through a ref
  // instead of re-subscribing on every render — a re-subscribe inside the chord window would
  // clear an armed `g`.
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    function clearPrefix() {
      pendingPrefix.current = null;
      if (prefixTimer.current !== null) {
        clearTimeout(prefixTimer.current);
        prefixTimer.current = null;
      }
    }

    function armPrefix(prefix: ChordPrefix) {
      clearPrefix();
      pendingPrefix.current = prefix;
      prefixTimer.current = setTimeout(clearPrefix, prefixTimeoutMs);
    }

    function handleKeyDown(event: KeyboardEvent) {
      // A Base UI popup (Select/Menu/Dialog) already preventDefaults Escape when it dismisses
      // itself — without this guard the window-level listener below still saw the same
      // keystroke and dispatched a second, unwanted "back" navigation on top of it. A key a
      // view consumed (the Cockpit's own `g p`) still ends an armed chord, or the stale
      // prefix would swallow the next `g`.
      if (event.defaultPrevented) {
        if (!isModifierKey(event.key)) clearPrefix();
        return;
      }
      const input = {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      };
      const ctx = {
        isTyping: isTypingTarget(event.target),
        modalOpen: isAnyModalOpen(),
        pendingPrefix: pendingPrefix.current,
      };
      const command = resolveGlobalKeyCommand(input, ctx);
      if (command === null) {
        const prefix = resolveChordPrefix(input, ctx);
        if (prefix !== null) {
          // The prefix key itself must not type anywhere; nothing else about the keystroke
          // is owned here.
          event.preventDefault();
          armPrefix(prefix);
          return;
        }
        // A modifier keystroke while a chord is armed (holding shift to type `?`, say) is
        // not the chord's second key; anything else — including a miss — ends the chord.
        if (!isModifierKey(event.key)) clearPrefix();
        return;
      }
      clearPrefix();
      // Every resolved command owns the keystroke — cmd+k in particular must not also type a
      // literal "k" into whatever's focused, and "/" must not land in a text field either.
      // Only commands the root layer actually resolves ever reach this point, so this never
      // suppresses a keystroke the root doesn't own (see C2 in the phase-8 fix report).
      event.preventDefault();
      onCommandRef.current(command);
    }

    // An armed chord takes its second key in the capture phase, before any view's own
    // handler can claim it (a focused list's `f` would open its filter instead of `g f`).
    function handleChordKey(event: KeyboardEvent) {
      if (pendingPrefix.current === null || event.defaultPrevented) return;
      const command = resolveChordKey(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        {
          isTyping: isTypingTarget(event.target),
          modalOpen: isAnyModalOpen(),
          pendingPrefix: pendingPrefix.current,
        }
      );
      if (command === null) return;
      clearPrefix();
      event.preventDefault();
      event.stopPropagation();
      onCommandRef.current(command);
    }

    window.addEventListener('keydown', handleChordKey, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleChordKey, true);
      window.removeEventListener('keydown', handleKeyDown);
      clearPrefix();
    };
  }, [prefixTimeoutMs]);
}

// Bare modifier keydowns (`Shift` before a `?`) arrive as their own events.
function isModifierKey(key: string): boolean {
  return (
    key === 'Shift' || key === 'Meta' || key === 'Control' || key === 'Alt'
  );
}
