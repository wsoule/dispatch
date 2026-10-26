'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import {
  PHONE_QUERY,
  REDUCED_MOTION_QUERY,
  trapTab,
  useDialogFocus,
  useMediaQuery,
  useScrollLock,
} from './dom';
import styles from './slide-over.module.css';
import type { SlideOverProps } from './types';

// The exit animation (drawer-out, 0.22s) plus a margin; onAnimationEnd
// usually unmounts sooner.
const EXIT_MS = 260;

/** The panel's width on a wide window, in px (slide-over.module.css
    `min(620px, 100vw)`): what a page passes as DependencyGraph's
    `coveredRight` while a slide-over is open over the graph. */
export const SLIDE_OVER_WIDTH = 620;

/**
 * Gr8r's slide-over drawer: a right-hand panel (min(620px, 100vw)) lifted
 * by a soft shadow and a 1px left edge, a 46px header bar (breadcrumb,
 * actions, close), and a scrolling body that opens with the title.
 *
 * Desktop: no scrim, the page stays usable beside it (clicking another row
 * can swap its content), while Tab cycles inside the panel. Phone: a scrim
 * and a scroll lock make it modal. Esc closes from anywhere; focus returns
 * to whatever opened it. It stays mounted for the exit slide, then unmounts.
 *
 * Content swapped in place while open (a new `contentKey`: a relation row,
 * a milestone's issue, a "Back to" crumb) scrolls the body back to the top
 * and, when focus was in the panel or dropped to <body> because the link
 * that had it unmounted, moves focus to the panel so the new title is
 * announced and Tab starts from the header. Focus out on the page (a list
 * row that swapped the drawer) stays put, and the element focus returns to
 * on close is still the one that opened the panel.
 */
export default function SlideOver({
  open,
  onClose,
  title,
  breadcrumb,
  actions,
  closeLabel = 'Close',
  initialFocusRef,
  contentKey,
  children,
}: SlideOverProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownKey = useRef<string | undefined>(undefined);
  const titleId = useId();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY);

  // Mounted while open and during the exit animation. Set during render
  // (not in an effect) so the first open frame already has the panel.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const closing = present && !open;

  useEffect(() => {
    if (!closing) return undefined;
    const timer = setTimeout(
      () => setPresent(false),
      reduceMotion ? 0 : EXIT_MS
    );
    return () => clearTimeout(timer);
  }, [closing, reduceMotion]);

  useDialogFocus(panelRef, open, initialFocusRef);
  useScrollLock(open && isPhone);

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
      panel.focus({ preventScroll: true });
    }
  }, [open, contentKey]);

  // Esc closes from anywhere on the page, unless something nearer (the
  // palette, an open menu) already handled it.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!present) return null;

  return (
    <>
      {isPhone ? (
        <div
          className={styles.scrim}
          data-state={closing ? 'closing' : 'open'}
          aria-hidden="true"
          onClick={onClose}
        />
      ) : null}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isPhone ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-hidden={closing ? 'true' : undefined}
        inert={closing}
        tabIndex={-1}
        className={styles.panel}
        data-state={closing ? 'closing' : 'open'}
        onKeyDown={(event) => {
          if (panelRef.current !== null) trapTab(event, panelRef.current);
        }}
        onAnimationEnd={(event) => {
          if (closing && event.target === event.currentTarget)
            setPresent(false);
        }}
      >
        <header className={styles.header}>
          <div className={styles.bar}>
            <div className={styles.crumb}>{breadcrumb}</div>
            <div className={styles.actions}>
              {actions}
              <button
                type="button"
                className={styles.close}
                aria-label={closeLabel}
                title={`${closeLabel} (Esc)`}
                onClick={onClose}
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </div>
        </header>
        <div ref={bodyRef} className={styles.body}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {children}
        </div>
      </div>
    </>
  );
}
