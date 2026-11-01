'use client';

import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { focusableWithin } from '../shell/dom';
import { cx } from '../tasks/class-names';
import { useAnchoredLayer } from './anchored';
import styles from './tooltip.module.css';
import type { TooltipProps } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Hover delay before a tip shows; keyboard focus shows it at once. */
const SHOW_DELAY_MS = 500;

/* A tip on hover (after a pause) or keyboard focus, hidden by Esc, leave or
   blur; always in the DOM so the control's aria-describedby reads it. */
export function Tooltip({
  content,
  children,
  side = 'above',
  className,
}: TooltipProps): ReactNode {
  const tipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shown, setShown] = useState(false);

  useAnchoredLayer(shown, tipRef, anchorRef, 'start', side);

  // Describe the wrapped control by the tip, keeping its own descriptions.
  useClientLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return undefined;
    const target = focusableWithin(anchor)[0] ?? anchor;
    const before = target.getAttribute('aria-describedby');
    const ids = (before ?? '').split(' ').filter((id) => id !== '');
    if (!ids.includes(tipId)) {
      target.setAttribute('aria-describedby', [...ids, tipId].join(' '));
    }
    return () => {
      if (before === null) target.removeAttribute('aria-describedby');
      else target.setAttribute('aria-describedby', before);
    };
  }, [tipId]);

  useEffect(() => {
    if (!shown) return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // Esc takes the tip first, not the dialog or drawer behind it.
      event.preventDefault();
      event.stopPropagation();
      setShown(false);
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [shown]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  function cancel(): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  function hide(): void {
    cancel();
    setShown(false);
  }

  return (
    <span
      ref={anchorRef}
      className={cx(styles.anchor, className)}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancel();
        timer.current = setTimeout(() => setShown(true), SHOW_DELAY_MS);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches(':focus-visible')) {
          cancel();
          setShown(true);
        }
      }}
      onBlur={hide}
    >
      {children}
      <span
        ref={tipRef}
        id={tipId}
        role="tooltip"
        popover="manual"
        hidden={!shown}
        className={styles.tip}
      >
        {content}
      </span>
    </span>
  );
}
