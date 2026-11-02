import { useEffect, useRef } from 'react';

import type { ChordPrefix, GlobalKeyCommand } from '../lib/keyboard';
import {
  isTypingTagName,
  resolveChordKey,
  resolveChordPrefix,
  resolveGlobalKeyCommand,
} from '../lib/keyboard';

/** An open picker, popover or menu (`data-picker-popup`; a submenu is only a
 * `role="menu"`) owns the letters typed into it, as a text field does: its list
 * takes them as typeahead and drops the ones no option starts with. Without
 * this, a letter with no match would reach the app's shortcuts (`c` opens the
 * composer, `g h` leaves the page) from inside the open list. */
const OWNS_ITS_KEYS = '[data-picker-popup], [role="menu"]';

/** True while the event's target is a text field (a checkbox or a button input is not one), or inside an open picker or menu — the DOM-touching half of
 * `GlobalKeyboardContext.isTyping` that `lib/keyboard.ts` itself stays pure of. Exported so
 * any other keydown-listening container that also holds real form controls (e.g. `BoardView`'s
 * roving-focus track, which wraps a milestone card's concurrency `<input>`) can build its own
 * `isTyping` the same way instead of hardcoding `false`. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    isTypingTagName(
      target.tagName,
      target.isContentEditable,
      target instanceof HTMLInputElement ? target.type : undefined
    ) || target.closest(OWNS_ITS_KEYS) !== null
  );
}

/** True unless an ancestor (or the element itself) is hidden with
 * `display: none` the way React's `<Activity mode="hidden">` hides a view:
 * an inline style. The element stays in the DOM, so presence alone does not
 * say it shows. */
export function isShown(element: Element): boolean {
  return (
    element.isConnected && element.closest('[style*="display: none"]') === null
  );
}

const MODAL_SURFACES =
  '[data-slot="alert-dialog-content"][data-open], [aria-modal="true"]';

/** True while any modal surface is currently open. The `@dispatch/ui` modal surfaces (Dialog
 * and ConfirmDialog, the slide-over, the command palette, the phone drawer) set
 * `aria-modal="true"` on their panel while open and unmount on close, so a bare
 * `[aria-modal="true"]` match covers them: NewDocDialog, PublishDialog, LiveView's Pause all
 * confirm, the Usage page's SessionDetailModal and the DispatchDialog form among them (a
 * closing SlideOver drops aria-modal for its exit slide, so an exiting panel is not caught).
 * The one Base UI dialog left is ui-legacy's alert dialog (FirstTaskGuide):
 * `AlertDialogContent` renders `data-slot="alert-dialog-content"`, and its popup carries a
 * bare `data-open` only while open (it flips to `data-closed` for the exit animation, so
 * presence in the DOM alone is not enough); a destructive confirm swallows the app's
 * shortcuts like any other modal. Checked live via a DOM query at the moment a keydown
 * fires, rather than threaded through as reactive React state: every dialog instance only
 * renders into the DOM while open, so the query is as current as the state would be, without
 * App.tsx needing to know about every modal anywhere in the tree (including ones mounted deep
 * inside the Sessions hub). CommandPalette is one of these too, so a keydown reaching this
 * listener while the palette is open resolves `Escape` to `null` here — the library's own
 * Escape handling owns it, and its `onClose` dispatching `closePalette` through `onNavigate`
 * is the only thing that closes it (see `appNav.ts`'s `closePalette` case). Exported for a
 * view whose own document-level Escape must let an open panel's go first (the Graph's lock,
 * `views/GraphView.tsx`). A surface inside a view hidden under Settings (an
 * `<Activity mode="hidden">` boundary keeps it in the DOM, aria-modal and all) is not shown,
 * so it does not count: Escape still closes Settings, and the dialog is there again when its
 * view comes back. */
export function isAnyModalOpen(): boolean {
  return Array.from(document.querySelectorAll(MODAL_SURFACES)).some(isShown);
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
