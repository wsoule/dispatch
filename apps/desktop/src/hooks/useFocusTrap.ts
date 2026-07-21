import { useEffect } from 'react';

// Elements a person can actually Tab to. Deliberately conservative (no `[contenteditable]`,
// no exhaustive ARIA-widget list) — every current use of this hook (TaskPeekPanel,
// CommandPalette) only ever contains plain inputs/buttons/links/selects.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function queryFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
}

/**
 * Traps Tab/Shift+Tab focus inside `containerRef` while `active` is true, focuses the
 * container's first focusable element the moment it becomes active, and restores focus to
 * whatever was focused beforehand once it deactivates (unmounts, or `active` flips back to
 * false) — the standard modal/overlay focus-discipline contract (I7 in the phase-8 fix
 * report), shared by `TaskPeekPanel` and `CommandPalette` rather than each hand-rolling its
 * own partial version. `Modal` (components/ui/Modal.tsx) is untouched — its own Escape
 * listener stays independent of this.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean
): void {
  useEffect(() => {
    if (!active) return;

    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const container = containerRef.current;
    if (container !== null) {
      const first = queryFocusable(container)[0];
      (first ?? container).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || container === null) return;
      const focusable = queryFocusable(container);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      invoker?.focus();
    };
  }, [active, containerRef]);
}
