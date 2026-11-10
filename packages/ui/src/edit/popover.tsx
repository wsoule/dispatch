'use client';

import {
  cloneElement,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { flushSync } from 'react-dom';

import { dataAttributes } from '../lib/data-attributes';
import { useMergedRef } from '../lib/refs';
import { focusableWithin, useMediaQuery, useScrollLock } from '../shell/dom';
import {
  followAnchor,
  hideFromTopLayer,
  positionLayer,
  SHEET_QUERY,
  showInTopLayer,
  useLayer,
} from '../shell/layer';
import styles from './popover.module.css';
import { useLatest } from './save-state';
import type { PopoverProps } from './types';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type CloseReason = 'escape' | 'outside' | 'tab' | 'done';

/** The props the Popover sets on (or reads from) its trigger element. */
interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  'aria-haspopup'?: 'dialog';
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

/** The first element Tab reaches in `root` (tabindex="-1" buttons
    excluded), or null. */
function firstFocusable(root: HTMLElement): HTMLElement | null {
  return (
    focusableWithin(root).find((el) => el.getAttribute('tabindex') !== '-1') ??
    null
  );
}

/**
 * Gr8r's popover: a non-modal panel anchored to its trigger (or to
 * `anchorRef`) holding a host's own content, such as a display panel or a
 * short form. A `role="dialog"` named by `label`, never `aria-modal`.
 *
 * The trigger is cloned with aria-haspopup="dialog", aria-expanded,
 * aria-controls and a click that toggles it. On open focus goes to the
 * first focusable element inside (`initialFocus`: 'panel', an element, or
 * false to leave it in the anchor). Escape, a press outside, Tab past the
 * last element (or Shift+Tab before the first) and the phone sheet's Done
 * close it; all but an outside press return focus to the trigger or
 * anchor (`returnFocus`). It renders in place, in the browser's top layer
 * (a fixed layer without the Popover API), and is one layer of the
 * package's stack: a PickerPopover inside closes first on Escape or an
 * outside press, and a press in the popover's own body closes only that
 * picker. At 640px and below it is a bottom sheet over the scrim. Its
 * layer carries data-picker-popup, as a picker's and a menu's do, so the
 * shell's `[`, the palette's keys and a table's row keys stand down inside.
 */
export function Popover(props: PopoverProps): ReactNode {
  const {
    open,
    onOpenChange,
    label,
    trigger,
    anchorRef,
    align = 'start',
    side = 'bottom',
    width,
    initialFocus = 'first',
    returnFocus = true,
    closeOnOutside = true,
    footer,
    children,
  } = props;

  const popupId = `${useId()}-popover`;
  const triggerRef = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery(SHEET_QUERY);
  const triggerElement =
    trigger === undefined ? undefined : (trigger as ReactElement<TriggerProps>);
  const setTriggerRef = useMergedRef(triggerRef, triggerElement?.props.ref);

  /** Where focus goes back to: `returnFocus()` when the host names an
      element, else the trigger, else the anchor. Tab and Shift+Tab leave
      from it too, so a popover anchored to an element that cannot take
      focus (a wrapper) still hands focus to a real control. */
  function home(): HTMLElement | null {
    return (
      (typeof returnFocus === 'function' ? returnFocus() : null) ??
      triggerRef.current ??
      anchorRef?.current ??
      null
    );
  }

  function focusBack(): void {
    if (returnFocus === false) return;
    home()?.focus({ preventScroll: true });
  }

  function close(reason: CloseReason): void {
    if (reason === 'outside') {
      // Focus goes where the press put it.
      onOpenChange(false);
      return;
    }
    if (reason === 'tab') {
      // Focus goes back home before the browser's own Tab step, and the
      // panel is gone by then, so Tab moves on from there.
      home()?.focus({ preventScroll: true });
      flushSync(() => onOpenChange(false));
      return;
    }
    onOpenChange(false);
    focusBack();
  }
  const closeRef = useLatest(close);

  useLayer({
    open,
    kind: 'popover',
    ref: layerRef,
    closeOnOutside,
    inside: () => [triggerRef.current, anchorRef?.current],
    onDismiss: (reason) => closeRef.current(reason),
  });

  useScrollLock(open && sheet);

  // Into the browser's top layer while open; declared before the
  // placement, which measures the layer where it landed.
  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    if (!open || layer === null) return undefined;
    showInTopLayer(layer);
    return () => hideFromTopLayer(layer);
  }, [open]);

  // Placement, then follow the anchor while the page scrolls or resizes
  // (and while the anchor itself changes size).
  const anchorLatest = useLatest(anchorRef);
  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    if (!open || layer === null) return undefined;
    const target = (): HTMLElement | null =>
      anchorLatest.current?.current ?? triggerRef.current;
    return followAnchor(layer, target(), () =>
      positionLayer(layer, target(), {
        panel: panelRef.current,
        sheet,
        side,
        align,
        prefix: '--popover',
      })
    );
  }, [open, sheet, side, align, width, anchorLatest]);

  // First focus, once the layer is placed (a hidden layer cannot take
  // focus), read once per opening: an inline ref object must not move
  // focus again on every render.
  const focusChoice = useLatest(initialFocus);
  useClientLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || panel === null) return;
    const choice = focusChoice.current;
    if (choice === false) return;
    let target: HTMLElement | null;
    if (choice === 'panel') target = panel;
    else if (choice === 'first') target = firstFocusable(panel) ?? panel;
    else target = choice.current ?? panel;
    target.focus({ preventScroll: true });
  }, [open, focusChoice]);

  // Closed by the host while focus was inside: the focused element is
  // gone, so focus would fall to <body>. Hand it back home.
  const homeRef = useLatest(home);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && returnFocus !== false) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        homeRef.current()?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = open;
  }, [open, returnFocus, homeRef]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close('escape');
      return;
    }
    const panel = panelRef.current;
    if (event.key !== 'Tab' || panel === null) return;
    const items = focusableWithin(panel);
    const active = document.activeElement;
    const leaving =
      items.length === 0 ||
      (event.shiftKey
        ? active === items[0] || active === panel
        : active === items[items.length - 1]);
    if (!leaving) return;
    if (event.shiftKey) {
      // Back to the trigger itself, the element before the popover.
      event.preventDefault();
      onOpenChange(false);
      home()?.focus({ preventScroll: true });
      return;
    }
    close('tab');
  }

  const triggerNode =
    triggerElement === undefined
      ? null
      : cloneElement(triggerElement, {
          ref: setTriggerRef,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? popupId : undefined,
          onClick: (event: MouseEvent<HTMLElement>) => {
            triggerElement.props.onClick?.(event);
            if (!event.defaultPrevented) onOpenChange(!open);
          },
        });

  const widthStyle =
    width === undefined
      ? undefined
      : ({
          '--popover-width':
            width === 'trigger'
              ? 'var(--popover-anchor-width)'
              : `${Math.round(width)}px`,
        } as CSSProperties);
  const hasFooter = footer !== undefined && footer !== null && footer !== false;

  return (
    <>
      {triggerNode}
      {open ? (
        <div
          {...dataAttributes(props)}
          ref={layerRef}
          id={popupId}
          role="dialog"
          aria-label={label}
          popover="manual"
          className={styles.layer}
          style={widthStyle}
          data-popover=""
          // An open popup, as a picker's or a menu's layer is: the shell's
          // `[`, the palette's keys and a table's row keys stand down here.
          data-picker-popup=""
          data-width={width === undefined ? undefined : 'set'}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            // The phone sheet's scrim (the layer around the panel).
            if (event.target === event.currentTarget) {
              event.preventDefault();
              close('done');
            }
          }}
        >
          <div ref={panelRef} className={styles.panel} tabIndex={-1}>
            <div className={styles.body}>{children}</div>
            {hasFooter || sheet ? (
              <div className={styles.foot}>
                {footer}
                {sheet ? (
                  <button
                    type="button"
                    className={styles.done}
                    onClick={() => close('done')}
                  >
                    Done
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
