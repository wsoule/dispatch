'use client';

import { X } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useLatest } from '../edit/save-state';
import { dataAttributes } from '../lib/data-attributes';
import { Button } from '../tasks/button';
import { cx } from '../tasks/class-names';
import styles from './dialog.module.css';
import { focusableWithin, trapTab, useScrollLock } from './dom';
import { hideFromTopLayer, showInTopLayer, useLayer } from './layer';
import type { ConfirmDialogProps, DialogProps } from './types';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Where a dialog's focus lands when it opens: the first enabled control
 * Tab reaches outside the header row (its Back action and close button),
 * so a form opens with the caret in its first field rather than a ring on
 * the close button. A dialog with nothing to focus but its header (a
 * reading view) focuses the panel itself, so its title is announced.
 */
function initialFocusTarget(
  panel: HTMLElement,
  header: HTMLElement | null
): HTMLElement {
  return (
    focusableWithin(panel).find(
      (el) =>
        el.getAttribute('tabindex') !== '-1' &&
        (header === null || !header.contains(el))
    ) ?? panel
  );
}

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/**
 * Gr8r's modal dialog: a centred --surface card (12px radius, the pop
 * shadow) over the --overlay scrim, 360, 520 or 880px wide, a
 * full-width sheet on phones. A title row (an optional `titleAction`
 * such as Back, the title, the close button), an optional description,
 * a scrolling body and a footer (`footerLeading`, then `actions`).
 *
 * `role="dialog"` with aria-modal="true", named by its title and
 * described by its description. It renders in place, in the browser's
 * top layer, and is the modal layer of the package's stack: Tab cycles
 * inside it, the page behind does not scroll, and focus goes to the first
 * enabled control outside the header row (or `initialFocusRef`, or the
 * panel) and back to the opener on close. Escape closes it with
 * preventDefault() and stopPropagation(), so a SlideOver beneath and the
 * host's shortcuts never see the key; a picker, popover or tooltip inside
 * takes Escape and outside presses first and never closes it.
 * `dismissible={false}` (while busy) ignores Escape, the scrim and the
 * close button.
 */
export function Dialog(props: DialogProps): ReactNode {
  const {
    open,
    onClose,
    title,
    description,
    size = 'md',
    titleAction,
    actions,
    footerLeading,
    initialFocusRef,
    dismissible = true,
    dismissOnOutsideClick = true,
    closeLabel = 'Close',
    contentKey,
    role = 'dialog',
    children,
  } = props;
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const latest = useLatest({ onClose, dismissible });
  const focusRef = useLatest(initialFocusRef);

  useLayer({
    open,
    kind: 'modal',
    ref: panelRef,
    closeOnOutside: dismissible && dismissOnOutsideClick,
    onDismiss: () => {
      if (latest.current.dismissible) latest.current.onClose();
    },
  });
  useScrollLock(open);

  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    if (!open || layer === null) return undefined;
    showInTopLayer(layer);
    return () => hideFromTopLayer(layer);
  }, [open]);

  // Focus in on open, and back to whatever had it on close (if that
  // element is still in the document).
  useClientLayoutEffect(() => {
    if (!open) return undefined;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    if (panel !== null) {
      const target =
        focusRef.current?.current ??
        initialFocusTarget(panel, headerRef.current);
      target.focus({ preventScroll: true });
    }
    return () => {
      if (previous !== null && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, focusRef]);

  // A new step swapped in while open: back to the top, and focus (if it
  // was in the dialog or fell to <body> with the old step) to the new
  // step's first field.
  const shownKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = shownKey.current;
    shownKey.current = open ? contentKey : undefined;
    if (!open || previous === undefined || contentKey === undefined) return;
    if (previous === contentKey) return;
    const panel = panelRef.current;
    if (panel === null) return;
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0;
    const active = document.activeElement;
    if (active === null || active === document.body || panel.contains(active)) {
      (
        focusRef.current?.current ??
        initialFocusTarget(panel, headerRef.current)
      ).focus({ preventScroll: true });
    }
  }, [open, contentKey, focusRef]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      if (event.nativeEvent.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (event.key === 'Tab' && panelRef.current !== null) {
      trapTab(event, panelRef.current);
      // A SlideOver around an in-place dialog traps Tab too: one trap.
      event.stopPropagation();
    }
  }

  if (!open) return null;

  const hasFooter = present(actions) || present(footerLeading);

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      popover="manual"
      data-dialog-layer=""
    >
      {/* A press on the scrim must not move focus out of the dialog; the
          layer stack closes it from there (dismissOnOutsideClick). */}
      <div
        className={styles.scrim}
        aria-hidden="true"
        onMouseDown={(event) => event.preventDefault()}
      />
      <div
        {...dataAttributes(props)}
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={present(description) ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(styles.panel, styles[size])}
        data-size={size}
        onKeyDown={onKeyDown}
      >
        <div ref={headerRef} className={styles.header}>
          <div className={styles.titleRow}>
            {present(titleAction) ? (
              <div className={styles.titleAction}>{titleAction}</div>
            ) : null}
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {role === 'dialog' ? (
              <button
                type="button"
                className={styles.close}
                aria-label={closeLabel}
                title={`${closeLabel} (Esc)`}
                disabled={!dismissible}
                onClick={onClose}
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {present(description) ? (
            <div id={descriptionId} className={styles.description}>
              {description}
            </div>
          ) : null}
        </div>
        {present(children) ? (
          <div ref={bodyRef} className={styles.body}>
            {children}
          </div>
        ) : null}
        {hasFooter ? (
          <div className={styles.footer}>
            {present(footerLeading) ? (
              <div className={styles.leading}>{footerLeading}</div>
            ) : null}
            <div className={styles.actions}>{actions}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Gr8r's confirmation before a destructive or irreversible write: a small
 * `role="alertdialog"` (aria-modal, no close button, no scrim dismissal)
 * with the question as its title, the consequence as its description, and
 * Cancel then the confirm button. Cancel takes focus first, so Enter
 * right away cancels; with `tone="danger"` the confirm button is the red
 * danger Button and Enter on it does nothing (a click or Space confirms).
 * Escape means Cancel. Each callback runs once per opening, and either
 * button closes it at once, whether or not the host has flipped `open`
 * yet. A promise from `onConfirm` keeps it open with the confirm button
 * busy until it settles; a rejection re-enables it (the host reports the
 * error).
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const {
    open,
    title,
    children,
    confirmLabel,
    cancelLabel = 'Cancel',
    tone = 'default',
    busy = false,
    onConfirm,
    onCancel,
  } = props;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [running, setRunning] = useState(false);
  // Closed by one of its own buttons: hidden until the host closes it.
  const [answered, setAnswered] = useState(false);
  if (!open && answered) setAnswered(false);
  // A callback already ran in this opening.
  const done = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) done.current = false;
  }, [open]);
  const waiting = busy || running;

  function cancel(): void {
    if (waiting || done.current) return;
    done.current = true;
    setAnswered(true);
    onCancel();
  }

  function confirm(): void {
    if (waiting || done.current) return;
    done.current = true;
    const result = onConfirm();
    if (!isThenable(result)) {
      setAnswered(true);
      return;
    }
    setRunning(true);
    void result.then(
      () => {
        if (!mounted.current) return;
        setRunning(false);
        setAnswered(true);
      },
      () => {
        if (!mounted.current) return;
        setRunning(false);
        done.current = false;
      }
    );
  }

  return (
    <Dialog
      {...dataAttributes(props)}
      open={open && !answered}
      onClose={cancel}
      title={title}
      description={children}
      size="sm"
      role="alertdialog"
      dismissible={!waiting}
      dismissOnOutsideClick={false}
      initialFocusRef={cancelRef}
      actions={
        <>
          <Button ref={cancelRef} disabled={waiting} onClick={cancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            busy={waiting}
            busyLabel="Working…"
            onClick={confirm}
            onKeyDown={(event) => {
              // A destructive action is never one Enter away.
              if (tone === 'danger' && event.key === 'Enter') {
                event.preventDefault();
              }
            }}
            data-confirm=""
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
