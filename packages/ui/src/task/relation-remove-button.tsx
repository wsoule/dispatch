'use client';

import { X } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { saveErrorMessage } from '../edit/save-state';
import styles from './task-relation-list.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])';

/**
 * Where focus goes when the removed row was the list's last one (the list
 * itself is about to be replaced by its empty note): the first control of
 * the surrounding section outside the list (in TaskDetail that is the
 * heading's "Add" picker), else the section's heading, made focusable for
 * the moment. Without it focus would fall to <body>, outside a drawer's
 * Tab trap, and a keyboard user would lose their place.
 */
function sectionFallback(list: Element | null): HTMLElement | null {
  const section = list?.closest('section');
  if (section === null || section === undefined || list === null) return null;
  // Array.from: a host's lib may lack DOM.Iterable (see shell/dom.ts).
  for (const element of Array.from(
    section.querySelectorAll<HTMLElement>(FOCUSABLE)
  )) {
    if (!list.contains(element)) return element;
  }
  const headingId = section.getAttribute('aria-labelledby');
  const heading =
    headingId === null ? null : section.ownerDocument.getElementById(headingId);
  if (heading === null) return null;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

/**
 * A relation row's remove button. When `onRemove` returns a promise the
 * button is busy (and the row muted) until it settles; a rejection prints
 * its message under the row. When the removal lands the row goes away, and
 * focus moves to a neighbouring row's remove button instead of being lost
 * with it (or, for the last row, to the section's "Add" control or
 * heading).
 */
export function RelationRemoveButton({
  taskKey,
  removeLabel,
  notSavedLabel,
  onRemove,
}: {
  taskKey: string;
  removeLabel: string;
  notSavedLabel: string;
  onRemove: () => void | Promise<unknown>;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  // Runs while the row is still in the document (layout cleanups precede
  // the DOM removal), so the neighbours can still be found.
  useLayoutEffect(() => {
    mounted.current = true;
    const button = buttonRef.current;
    return () => {
      mounted.current = false;
      if (button === null || document.activeElement !== button) return;
      const item = button.closest('li');
      const pick = (sibling: Element | null | undefined) =>
        sibling?.querySelector<HTMLButtonElement>('[data-relation-remove]');
      const next =
        pick(item?.nextElementSibling) ??
        pick(item?.previousElementSibling) ??
        sectionFallback(item?.parentElement ?? null);
      next?.focus({ preventScroll: true });
    };
  }, []);

  function remove(): void {
    if (pending) return;
    setError(null);
    // Typed without `void` so a host compiling without strictNullChecks
    // still sees a promise after the undefined check below.
    let result: Promise<unknown> | undefined;
    try {
      result = onRemove() as Promise<unknown> | undefined;
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    if (result === undefined) return;
    setPending(true);
    void result.then(
      () => {
        if (mounted.current) setPending(false);
      },
      (rejection: unknown) => {
        if (!mounted.current) return;
        setPending(false);
        setError(saveErrorMessage(rejection, 'Could not remove.'));
      }
    );
  }

  const name = `${removeLabel} ${taskKey}`;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.remove}
        aria-label={name}
        title={name}
        // aria-disabled, not disabled: the button keeps focus while busy.
        aria-disabled={pending ? 'true' : undefined}
        aria-busy={pending ? 'true' : undefined}
        data-relation-remove=""
        onClick={remove}
      >
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {error !== null ? (
        <span className={styles.removeError} role="alert">
          <span className={styles.removeErrorKey}>{notSavedLabel}</span>
          <span dir="auto">{error}</span>
        </span>
      ) : null}
    </>
  );
}
