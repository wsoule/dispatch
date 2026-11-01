'use client';

import { Maximize2, Minimize2, X } from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';

import { useLatest } from '../edit/save-state';
import { focusableWithin, trapTab, useScrollLock } from '../shell/dom';
import { Button } from '../tasks/button';
import { cx } from '../tasks/class-names';
import styles from './dialog.module.css';
import type { ConfirmDialogProps, DialogProps, DialogSize } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface ModalProps {
  open: boolean;
  role: 'dialog' | 'alertdialog';
  /** Esc, and a click on the scrim when `scrimCloses`. */
  onDismiss: () => void;
  scrimCloses: boolean;
  titleId: string;
  descriptionId: string | undefined;
  size: DialogSize;
  placement: 'center' | 'top';
  /** The element to focus on open; null falls back to the dialog. */
  initialFocus: () => HTMLElement | null;
  children: ReactNode;
}

/* Shared modal mechanics: native showModal, focus in and back out, Tab kept
   inside, Esc and the scrim dismissing, the page scroll locked. */
function Modal({
  open,
  role,
  onDismiss,
  scrimCloses,
  titleId,
  descriptionId,
  size,
  placement,
  initialFocus,
  children,
}: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusRef = useLatest(initialFocus);
  useScrollLock(open);

  useClientLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null) return undefined;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    }
    (focusRef.current() ?? dialog).focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      if (previous !== null && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, focusRef]);

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      className={styles.modal}
      data-placement={placement}
      onCancel={(event) => {
        // Closing is the host's call (open is controlled).
        event.preventDefault();
        onDismiss();
      }}
      onKeyDown={(event) => {
        if (dialogRef.current !== null) trapTab(event, dialogRef.current);
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing
        ) {
          return;
        }
        event.preventDefault();
        onDismiss();
      }}
      onClick={(event) => {
        // The dialog box is the transparent full-screen frame: a click on
        // it, outside the panel, is a click on the scrim.
        if (scrimCloses && event.target === event.currentTarget) onDismiss();
      }}
    >
      <div className={styles.panel} data-size={size}>
        {children}
      </div>
    </dialog>
  );
}

/* Gr8r's modal card: title, description, scrolling body and footer actions;
   `crumb` adds the chrome row with close and Expand. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  titleHidden = false,
  crumb,
  onExpand,
  expanded = false,
  footer,
  footerStart,
  size = 'md',
  placement = 'center',
  closeButton = true,
  initialFocusRef,
  closeLabel = 'Close',
  children,
}: DialogProps): ReactNode {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const hasDescription =
    description !== undefined && description !== null && description !== false;
  const descriptionId = hasDescription ? `${baseId}-description` : undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const hasCrumb = crumb !== undefined && crumb !== null && crumb !== false;
  const hasFooter =
    (footer !== undefined && footer !== null) ||
    (footerStart !== undefined && footerStart !== null);

  const close = closeButton ? (
    <Button
      variant="quiet"
      size="sm"
      icon={<X size={14} strokeWidth={1.8} />}
      aria-label={closeLabel}
      title={`${closeLabel} (Esc)`}
      onClick={onClose}
    />
  ) : null;

  return (
    <Modal
      open={open}
      role="dialog"
      onDismiss={onClose}
      scrimCloses
      titleId={titleId}
      descriptionId={descriptionId}
      size={size}
      placement={placement}
      initialFocus={() =>
        initialFocusRef?.current ??
        (bodyRef.current === null
          ? null
          : focusableWithin(bodyRef.current)[0]) ??
        (footerRef.current === null
          ? null
          : focusableWithin(footerRef.current)[0]) ??
        null
      }
    >
      {hasCrumb ? (
        <div className={styles.chrome}>
          <div className={styles.crumb}>{crumb}</div>
          {onExpand !== undefined ? (
            <Button
              variant="quiet"
              size="sm"
              icon={
                expanded ? (
                  <Minimize2 size={14} strokeWidth={1.8} />
                ) : (
                  <Maximize2 size={14} strokeWidth={1.8} />
                )
              }
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-pressed={expanded}
              onClick={onExpand}
            />
          ) : null}
          {close}
        </div>
      ) : null}
      <header
        className={cx(
          styles.header,
          titleHidden ? 'srOnly' : undefined,
          !hasCrumb && closeButton ? styles.headerWithClose : undefined
        )}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {hasDescription ? (
          <p id={descriptionId} className={styles.description}>
            {description}
          </p>
        ) : null}
      </header>
      {!hasCrumb && closeButton ? (
        <div className={styles.cornerClose}>{close}</div>
      ) : null}
      <div ref={bodyRef} className={styles.body}>
        {children}
      </div>
      {hasFooter ? (
        <footer ref={footerRef} className={styles.footer}>
          <div className={styles.footerStart}>{footerStart}</div>
          <div className={styles.actions}>{footer}</div>
        </footer>
      ) : null}
    </Modal>
  );
}

/* A confirmation (alertdialog) before an irreversible step. Focus starts on
   Cancel and the scrim does nothing, so a stray click never decides. */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
}: ConfirmDialogProps): ReactNode {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const hasDescription =
    description !== undefined && description !== null && description !== false;
  const descriptionId = hasDescription ? `${baseId}-description` : undefined;
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open={open}
      role="alertdialog"
      onDismiss={onCancel}
      scrimCloses={false}
      titleId={titleId}
      descriptionId={descriptionId}
      size="sm"
      placement="center"
      initialFocus={() => cancelRef.current}
    >
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {hasDescription ? (
          <p id={descriptionId} className={styles.description}>
            {description}
          </p>
        ) : null}
      </header>
      <footer className={styles.footer}>
        <div className={styles.footerStart} />
        <div className={styles.actions}>
          <Button ref={cancelRef} variant="quiet" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </footer>
    </Modal>
  );
}
