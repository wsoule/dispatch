'use client';

import {
  cloneElement,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { placePopover } from '../edit/position';
import { useMergedRef } from '../lib/refs';
import { useMediaQuery } from './dom';
import { hideFromTopLayer, showInTopLayer, useLayer } from './layer';
import styles from './tooltip.module.css';
import type { TooltipProps } from './types';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A touch screen: no hover-open (a tap would show it and never leave). */
const COARSE_QUERY = '(pointer: coarse)';
/** A tooltip that closed less than this long ago keeps the next one warm:
    moving along a toolbar shows each hint at once. */
const WARM_MS = 400;
/** How long a hover tip stays after the pointer leaves its trigger, so the
    pointer can cross the gap onto the tip (WCAG 1.4.13, hoverable). */
const GRACE_MS = 120;
const GAP = 6;
const MARGIN = 8;

/** When a tooltip last closed, across every tooltip on the page. */
let lastClosedAt = Number.NEGATIVE_INFINITY;

/** The props the Tooltip sets on (or reads from) its child element. */
interface ChildProps {
  ref?: Ref<HTMLElement>;
  tabIndex?: number;
  href?: string;
  disabled?: boolean;
  'aria-describedby'?: string;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}

const FOCUSABLE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'summary',
]);

/** Whether the child can take keyboard focus itself. A component (Button)
    is trusted to render a focusable element; a disabled control and a
    plain element (a span, a term) cannot, and get a focusable wrapper. */
function takesFocus(child: ReactElement<ChildProps>): boolean {
  const { type, props } = child;
  if (props.disabled === true) return false;
  if (typeof type !== 'string') return true;
  if (props.tabIndex !== undefined) return props.tabIndex >= 0;
  if (type === 'a') return props.href !== undefined;
  return FOCUSABLE_TAGS.has(type);
}

/** Keyboard focus, not a press: :focus-visible where the engine knows it. */
function focusIsVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Places the tip beside its anchor: on the preferred side, flipped when it
 * does not fit there, centred on the anchor and kept inside the viewport.
 * Top and bottom go through placePopover; left and right are the same
 * rule turned on its side.
 */
function placeTip(
  tip: HTMLElement,
  anchor: HTMLElement,
  side: NonNullable<TooltipProps['side']>
): void {
  const box = anchor.getBoundingClientRect();
  const size = { width: tip.offsetWidth, height: tip.offsetHeight };
  const clientWidth = document.documentElement.clientWidth;
  const viewport = {
    width: clientWidth > 0 ? clientWidth : window.innerWidth,
    height: window.innerHeight,
  };
  let placedSide: string;
  let left: number;
  let top: number;
  if (side === 'left' || side === 'right') {
    const right = viewport.width - box.right - GAP - MARGIN;
    const leftRoom = box.left - GAP - MARGIN;
    const onRight =
      side === 'right'
        ? size.width <= right || right >= leftRoom
        : !(size.width <= leftRoom || leftRoom >= right);
    placedSide = onRight ? 'right' : 'left';
    left = onRight ? box.right + GAP : box.left - GAP - size.width;
    top = (box.top + box.bottom) / 2 - size.height / 2;
    top = Math.max(
      MARGIN,
      Math.min(top, viewport.height - MARGIN - size.height)
    );
  } else {
    const placement = placePopover({
      anchor: box,
      size,
      viewport,
      gap: GAP,
      margin: MARGIN,
      align: 'center',
      side: side === 'top' ? 'above' : 'below',
    });
    placedSide = placement.side === 'above' ? 'top' : 'bottom';
    left = placement.left;
    top =
      placement.top ?? viewport.height - (placement.bottom ?? 0) - size.height;
  }
  tip.dataset.side = placedSide;
  tip.style.setProperty('--tooltip-left', `${Math.round(left)}px`);
  tip.style.setProperty('--tooltip-top', `${Math.round(top)}px`);
  tip.dataset.placed = 'true';
}

/**
 * Gr8r's tooltip: a short hint in an inverted chip (--text fill,
 * --text-inv words, 12px, at most 256px wide) beside its trigger, in the
 * browser's top layer. No provider.
 *
 * It shows on hover after `delay` (300ms; at once while another tooltip
 * closed under 400ms ago) and at once on keyboard focus, never on a
 * touch screen's hover or a press, and hides on leave (after a short
 * grace, so the pointer can move onto the tip), blur, a press, a scroll
 * that moves its trigger, and Escape from its trigger (an Escape typed
 * elsewhere hides it and goes on to its own target). While shown the
 * child carries `aria-describedby` to the `role="tooltip"` element, which
 * is aria-hidden so it never joins the text of a heading or sentence it
 * sits in; nothing is rendered while hidden.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  delay = 300,
  defaultOpen = false,
  disabled = false,
}: TooltipProps): ReactNode {
  const tipId = `${useId()}-tip`;
  const [open, setOpen] = useState(defaultOpen);
  const shown = open && !disabled;
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coarse = useMediaQuery(COARSE_QUERY);
  const child = children as ReactElement<ChildProps>;
  const wrapped = !takesFocus(child);
  const setAnchorRef = useMergedRef(
    anchorRef,
    wrapped ? undefined : child.props.ref
  );

  function clearTimer(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function show(now: boolean): void {
    clearTimer();
    if (disabled || open) return;
    const warm = Date.now() - lastClosedAt < WARM_MS;
    if (now || warm || delay <= 0) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, delay);
  }

  function hide(): void {
    clearTimer();
    setOpen(false);
  }

  // The pointer left the trigger or the tip: hide after a short grace,
  // which the tip (or the trigger) cancels when the pointer reaches it.
  function hideSoon(): void {
    clearTimer();
    if (!open) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(false);
    }, GRACE_MS);
  }

  useEffect(() => clearTimer, []);

  // The warm window starts when a shown tooltip goes (closed or unmounted),
  // in the commit that removes it.
  useClientLayoutEffect(() => {
    if (!shown) return undefined;
    return () => {
      lastClosedAt = Date.now();
    };
  }, [shown]);

  useLayer({
    open: shown,
    kind: 'tooltip',
    ref: tipRef,
    // Its trigger is the one place it takes Escape from.
    inside: () => [anchorRef.current],
    onDismiss: () => hide(),
  });

  // Into the top layer, placed beside the anchor. A scroll that moves the
  // anchor (the page, or a pane holding it) hides it; any other scroll
  // (a streaming chat beside it following its bottom) only re-places it.
  useClientLayoutEffect(() => {
    const tip = tipRef.current;
    const anchor = anchorRef.current;
    if (!shown || tip === null) return undefined;
    showInTopLayer(tip);
    if (anchor !== null) placeTip(tip, anchor, side);
    else tip.dataset.placed = 'true';
    let frame = 0;
    const onScroll = (event: Event): void => {
      const scrolled = event.target;
      const movesAnchor =
        anchor === null ||
        scrolled === document ||
        (scrolled instanceof Node && scrolled.contains(anchor));
      if (movesAnchor) {
        hide();
        return;
      }
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        placeTip(tip, anchor, side);
      });
    };
    document.addEventListener('scroll', onScroll, true);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, true);
      hideFromTopLayer(tip);
    };
  }, [shown, side]);

  const handlers = {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      child.props.onPointerEnter?.(event);
      if (event.pointerType === 'touch' || coarse) return;
      show(false);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      child.props.onPointerLeave?.(event);
      hideSoon();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      child.props.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      child.props.onFocus?.(event);
      if (focusIsVisible(event.currentTarget)) show(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      child.props.onBlur?.(event);
      hide();
    },
  };
  const own = child.props['aria-describedby'];
  const describedBy = shown
    ? own === undefined || own === ''
      ? tipId
      : `${own} ${tipId}`
    : own;

  const trigger = wrapped ? (
    <span
      ref={setAnchorRef}
      // A hint must be reachable without a pointer: the wrapper takes the
      // focus its content cannot.
      tabIndex={0}
      className={styles.anchor}
      aria-describedby={shown ? tipId : undefined}
      {...handlers}
    >
      {child}
    </span>
  ) : (
    cloneElement(child, {
      ref: setAnchorRef,
      'aria-describedby': describedBy,
      ...handlers,
    })
  );

  return (
    <>
      {trigger}
      {shown ? (
        <span
          ref={tipRef}
          id={tipId}
          role="tooltip"
          // Rendered in place, inside a heading or a sentence: hidden from
          // the tree so it never joins their text. aria-describedby still
          // reads it as the trigger's description.
          aria-hidden="true"
          popover="manual"
          className={styles.tip}
          data-side={side}
          onPointerEnter={clearTimer}
          onPointerLeave={hideSoon}
        >
          {content}
        </span>
      ) : null}
    </>
  );
}
