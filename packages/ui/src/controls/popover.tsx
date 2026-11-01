'use client';

import {
  type FocusEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { focusableWithin } from '../shell/dom';
import { cx } from '../tasks/class-names';
import { useAnchoredLayer, useDismissOutside } from './anchored';
import styles from './popover.module.css';
import type { PopoverProps } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/* A non-modal dialog card anchored to its trigger. Focus moves in on open;
   Esc returns it to the trigger; a press outside or Tab out closes it. */
export function Popover({
  label,
  trigger,
  children,
  align = 'start',
  open: openProp,
  onOpenChange,
  initialFocusRef,
  className,
}: PopoverProps): ReactNode {
  const [openState, setOpenState] = useState(false);
  const isOpen = openProp ?? openState;
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  function setOpen(next: boolean): void {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }

  useAnchoredLayer(isOpen, layerRef, triggerRef, align);
  useDismissOutside(isOpen, [triggerRef, layerRef], () => setOpen(false));

  useClientLayoutEffect(() => {
    if (!isOpen) return;
    const layer = layerRef.current;
    if (layer === null) return;
    const target =
      initialFocusRef?.current ?? focusableWithin(layer)[0] ?? layer;
    target.focus({ preventScroll: true });
  }, [isOpen, initialFocusRef]);

  function onBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    if (layerRef.current?.contains(next) === true) return;
    if (triggerRef.current?.contains(next) === true) return;
    setOpen(false);
  }

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'dialog',
        'aria-expanded': isOpen,
        'aria-controls': isOpen ? panelId : undefined,
        onClick: () => setOpen(!isOpen),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' && !isOpen) {
            event.preventDefault();
            setOpen(true);
          }
        },
      })}
      {isOpen ? (
        <div
          ref={layerRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          popover="manual"
          tabIndex={-1}
          className={cx(styles.layer, className)}
          data-picker-popup=""
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          {children}
        </div>
      ) : null}
    </>
  );
}
