'use client';

import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

import { publishBulkBarHeight } from './bulk-bar-height';
import styles from './bulk-bar.module.css';
import type { BulkBarProps } from './types';

/* Gr8r's bulk bar (.bulkbar in task-list.js): an inverted toolbar that
   springs up at the bottom centre while rows are selected. "{n} selected", the host's action triggers
   (pickers with appearance 'bar'), then ✕.

   - The count is announced through a polite live region that stays
     mounted (empty) while nothing is selected, so the first selection is
     heard too: a region created already holding its text is not
     announced. While a change is being sent the count's place says so
     ("Moving 12 issues…") and the actions are disabled (they sit in a
     <fieldset>, so every host control in it is disabled natively). A
     `note` ("At most 100 at a time") disables them too. Disabling blurs
     the focused action; when the change is done, focus goes back to it
     (or the first action) if it fell to <body>.
   - `confirm` replaces the actions with an inline confirmation: the
     sentence, a primary button that takes focus, and Cancel. When the
     confirmation goes, focus returns to the first action.
   - Esc anywhere in the bar (a picker inside handles its own Esc first)
     clears the selection; the host then puts focus back in the list.
     ← and → move between the bar's buttons.
   - While it is up, the toasts stack above it (its height is published
     through useBulkBarHeight, bulk-bar-height.ts). */
export function BulkBar({
  count,
  countLabel,
  children,
  onClear,
  clearLabel = 'Clear selection',
  busy = null,
  note = null,
  confirm = null,
  label,
}: BulkBarProps): ReactNode {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLFieldSetElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const confirming = confirm !== null;
  const wasConfirming = useRef(false);
  const isBusy = busy !== null && busy !== '';
  const wasBusy = useRef(false);
  // The bar's own action last focused (a picker trigger, not a control
  // inside its open popover): where focus returns after a busy spell.
  const lastAction = useRef<HTMLElement | null>(null);

  // Into the confirmation: its primary button. Out of it (Cancel, or the
  // host dropping it): the first action, when focus was in the bar or
  // fell to <body> with the strip's buttons.
  // While the bar is up, the toasts stack above it and a host's list keeps
  // room under its last rows: both read the height published here
  // (useBulkBarHeight) and set it on their own element, so an Undo toast
  // never covers the selection's actions or ✕. The height follows the bar
  // (a confirmation can wrap on a phone).
  const shown = count > 0;
  useEffect(() => {
    const bar = barRef.current;
    if (!shown || bar === null) return undefined;
    const measure = () => {
      publishBulkBarHeight(Math.round(bar.getBoundingClientRect().height));
    };
    measure();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      publishBulkBarHeight(null);
    };
  }, [shown]);

  useEffect(() => {
    if (confirming && !wasConfirming.current) {
      confirmRef.current?.focus();
    } else if (!confirming && wasConfirming.current) {
      const active = document.activeElement;
      const inBar =
        active === null ||
        active === document.body ||
        barRef.current?.contains(active) === true;
      if (inBar) {
        actionsRef.current
          ?.querySelector<HTMLElement>('button:not(:disabled)')
          ?.focus();
      }
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  // Out of a busy spell (the change answered): the disabled fieldset
  // blurred the action that sent it, so focus is on <body>. Put it back on
  // that action, else on the first one; a person who moved focus on
  // meanwhile keeps it.
  useEffect(() => {
    if (!isBusy && wasBusy.current) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        const last = lastAction.current;
        const target =
          last !== null &&
          last.isConnected &&
          actionsRef.current?.contains(last) === true &&
          !(last as HTMLButtonElement).disabled
            ? last
            : actionsRef.current?.querySelector<HTMLElement>(
                'button:not(:disabled)'
              );
        target?.focus();
      }
    }
    wasBusy.current = isBusy;
  }, [isBusy]);

  const hasNote = note !== null && note !== '';
  const statusText =
    count <= 0 ? '' : isBusy ? busy : (countLabel ?? `${count} selected`);
  // Always mounted, first in the fragment (the same node with or without
  // the bar), so the region exists before its first text arrives.
  const live = (
    <span className="srOnly" role="status" data-bulk-bar-status="">
      {statusText}
    </span>
  );

  const name =
    label ??
    `Actions for ${count} selected ${count === 1 ? 'issue' : 'issues'}`;

  // Esc clears (or cancels the confirmation); ← and → move between the
  // bar's own buttons, as in any toolbar. Keys inside an open picker are
  // the picker's.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-picker-popup]') !== null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirm !== null) confirm.onCancel();
      else onClear();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = Array.from(
      barRef.current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)'
      ) ?? []
    ).filter((button) => button.closest('[data-picker-popup]') === null);
    const at = buttons.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    const next = buttons[at + (event.key === 'ArrowRight' ? 1 : -1)];
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  if (count <= 0) {
    return (
      <>
        {live}
        {null}
      </>
    );
  }

  return (
    <>
      {live}
      <div
        ref={barRef}
        className={styles.bar}
        role="toolbar"
        aria-label={name}
        data-bulk-bar="true"
        data-busy={isBusy ? 'true' : undefined}
        onKeyDown={onKeyDown}
      >
        {/* The visible count; the live region above speaks it, and the
          toolbar's name carries it too. */}
        <span className={styles.count} aria-hidden="true">
          {statusText}
        </span>
        <span className={styles.sep} aria-hidden="true" />
        {confirm !== null ? (
          <span className={styles.confirm}>
            <span className={styles.message}>{confirm.message}</span>
            <span className={styles.confirmActions}>
              <button
                ref={confirmRef}
                type="button"
                className={styles.primary}
                onClick={confirm.onConfirm}
              >
                {confirm.confirmLabel}
              </button>
              <button
                type="button"
                className={styles.ghost}
                onClick={confirm.onCancel}
              >
                {confirm.cancelLabel ?? 'Cancel'}
              </button>
            </span>
          </span>
        ) : (
          <>
            <fieldset
              ref={actionsRef}
              className={styles.actions}
              disabled={isBusy || hasNote}
              onFocus={(event) => {
                const button = (event.target as HTMLElement).closest('button');
                if (
                  button !== null &&
                  button.closest('[data-picker-popup]') === null
                ) {
                  lastAction.current = button;
                }
              }}
            >
              {children}
            </fieldset>
            {hasNote ? <span className={styles.note}>{note}</span> : null}
          </>
        )}
        <span className={styles.sep} aria-hidden="true" />
        <button
          type="button"
          className={styles.close}
          aria-label={clearLabel}
          title={clearLabel}
          onClick={onClear}
        >
          <X size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
