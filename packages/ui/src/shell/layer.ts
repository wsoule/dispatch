'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { placePopover } from '../edit/position';
import { useLatest } from '../edit/save-state';

// The overlay layer stack shared by every floating thing in the package
// (PickerPopover, Popover, Tooltip, Dialog): where a layer goes in the
// browser's top layer, how it is placed against its anchor, and which
// open layer an Escape or an outside press belongs to. Overlays render in
// place (never portalled), so a picker inside a dialog is a DOM child of
// it and the focus traps' `contains` checks keep working.

/** Phones get a bottom sheet instead of an anchored popover (PickerPopover,
    Popover): the stylesheets' `width <= 640px`. */
export const SHEET_QUERY = '(max-width: 640px)';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Puts a layer in the browser's top layer when the Popover API is there,
    so no overflow, transform or z-index of the host can clip or cover it;
    otherwise it stays a fixed layer (see positionLayer). The element needs
    `popover="manual"`. */
export function showInTopLayer(layer: HTMLElement): void {
  if (typeof layer.showPopover !== 'function') return;
  try {
    if (!layer.matches(':popover-open')) layer.showPopover();
  } catch {
    // An engine without :popover-open, or a detached node: the fixed
    // fallback still positions it.
  }
}

/** Takes a layer back out of the top layer. A layer that unmounts leaves
    it by itself; this is for one that stays in the DOM, and it never
    throws (a detached node, an engine without the API). */
export function hideFromTopLayer(layer: HTMLElement): void {
  if (typeof layer.hidePopover !== 'function') return;
  try {
    if (layer.matches(':popover-open')) layer.hidePopover();
  } catch {
    // Already hidden or detached: nothing to undo.
  }
}

interface Outset {
  x: number;
  y: number;
}

const NO_OUTSET: Outset = { x: 0, y: 0 };

interface PositionOptions {
  /** The box measured at its natural (CSS-capped) size: the panel inside
      the layer. */
  panel: HTMLElement | null;
  /** Phones: the stylesheet draws a bottom sheet and nothing is measured. */
  sheet?: boolean;
  /** The preferred side; it flips when the layer does not fit there and
      the other side has more room. Default 'bottom'. */
  side?: 'bottom' | 'top';
  /** Which anchor edge the layer lines up with. Default 'start'. */
  align?: 'start' | 'end';
  /** How far the anchor's drawn frame reaches outside its box (the
      picker trigger's pill), so the layer lines up with the frame. */
  outset?: Outset;
  /** Space between the anchor and the layer. Default 4. */
  gap?: number;
  /** Prefix of the custom properties the stylesheet reads: '--picker'
      writes --picker-top, --picker-left, --picker-bottom,
      --picker-max-height and --picker-anchor-width. Default '--layer'. */
  prefix?: string;
}

/**
 * Anchors an open layer to its anchor (an element, or a viewport point
 * such as a context menu's pointer position): measures the panel at its
 * natural size, asks placePopover for a side and offsets, and writes them
 * as custom properties the stylesheet reads (`data-side` says below,
 * above or sheet). Outside the top layer a transformed ancestor makes
 * `position: fixed` relative to that ancestor, so the layer is measured
 * where it landed and corrected by the difference.
 */
export function positionLayer(
  layer: HTMLElement,
  anchor: HTMLElement | { x: number; y: number } | null,
  options: PositionOptions
): void {
  const {
    panel,
    sheet = false,
    side = 'bottom',
    align = 'start',
    outset = NO_OUTSET,
    gap,
    prefix = '--layer',
  } = options;
  const style = layer.style;
  if (sheet || anchor === null || panel === null) {
    layer.dataset.side = 'sheet';
    layer.dataset.placed = 'true';
    return;
  }
  // An element lines up by its drawn frame (the outset); a point is a box
  // of no size.
  const rect =
    anchor instanceof HTMLElement
      ? (() => {
          const box = anchor.getBoundingClientRect();
          return {
            top: box.top - outset.y,
            bottom: box.bottom + outset.y,
            left: box.left - outset.x,
            right: box.right + outset.x,
          };
        })()
      : { top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x };
  style.setProperty(
    `${prefix}-anchor-width`,
    `${Math.round(rect.right - rect.left)}px`
  );
  style.removeProperty(`${prefix}-max-height`);
  const clientWidth = document.documentElement.clientWidth;
  const viewport = {
    width: clientWidth > 0 ? clientWidth : window.innerWidth,
    height: window.innerHeight,
  };
  const placement = placePopover({
    anchor: rect,
    size: { width: panel.offsetWidth, height: panel.offsetHeight },
    viewport,
    align,
    gap,
    side: side === 'top' ? 'above' : 'below',
  });
  layer.dataset.side = placement.side;
  style.setProperty(`${prefix}-max-height`, `${placement.maxHeight}px`);
  style.setProperty(`${prefix}-left`, `${placement.left}px`);
  if (placement.top !== null) {
    style.setProperty(`${prefix}-top`, `${placement.top}px`);
  }
  if (placement.bottom !== null) {
    style.setProperty(`${prefix}-bottom`, `${placement.bottom}px`);
  }
  const landed = layer.getBoundingClientRect();
  if (landed.width > 0 || landed.height > 0) {
    const dx = landed.left - placement.left;
    if (Math.abs(dx) > 0.5) {
      style.setProperty(`${prefix}-left`, `${placement.left - dx}px`);
    }
    if (placement.top !== null) {
      const dy = landed.top - placement.top;
      if (Math.abs(dy) > 0.5) {
        style.setProperty(`${prefix}-top`, `${placement.top - dy}px`);
      }
    } else if (placement.bottom !== null) {
      const dy = landed.bottom - (viewport.height - placement.bottom);
      if (Math.abs(dy) > 0.5) {
        style.setProperty(`${prefix}-bottom`, `${placement.bottom + dy}px`);
      }
    }
  }
  layer.dataset.placed = 'true';
}

// ---- the stack --------------------------------------------------------

type LayerKind = 'modal' | 'popover' | 'tooltip';
type DismissReason = 'escape' | 'outside' | 'tab';

interface LayerEntry {
  kind: LayerKind;
  /** The layer's own element: an Escape from inside it is the layer's
      own handler's to take. */
  element: () => HTMLElement | null;
  /** The press landed in this layer (or in an element it counts as its
      own, such as its trigger). */
  holds: (target: Node) => boolean;
  closeOnOutside: () => boolean;
  dismiss: (reason: DismissReason) => void;
}

/** Every open layer, bottom first. */
const stack: LayerEntry[] = [];

/** The topmost open layer, or the topmost one that is not a tooltip. */
function topLayer(skipTooltips: boolean): LayerEntry | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (!skipTooltips || entry.kind !== 'tooltip') return entry;
  }
  return undefined;
}

/**
 * Whether `target` sits in a modal surface that is not part of this stack
 * and does not hold `top` (Dispatch's command palette, a host's own
 * aria-modal dialog): that surface owns its keys and presses, so the
 * layers beneath it never take them. A Dialog of the stack, or a modal
 * SlideOver holding the open picker, does hold `top` and is not foreign.
 */
function inForeignModal(target: Node, top: LayerEntry): boolean {
  const from = target instanceof Element ? target : target.parentElement;
  const modal = from?.closest('[aria-modal="true"]') ?? null;
  if (modal === null) return false;
  const element = top.element();
  return element === null || !modal.contains(element);
}

/**
 * A press outside the top layer dismisses it, and every non-modal layer
 * under it that does not hold the press either (a picker inside a popover
 * and the popover close together on a press in the page; a press in the
 * popover's own body closes only the picker). It stops at the first layer
 * that holds the press, at one that keeps itself open on outside presses,
 * and at a modal that is not the top (a press on a dialog's scrim with a
 * picker open closes the picker only). Tooltips hold nothing to press, so
 * any press elsewhere hides them and they never stand between a press and
 * the layer under them. A press in a modal surface outside the stack is
 * that surface's own.
 */
function onStackPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node)) return;
  const target = event.target;
  for (const entry of stack.slice()) {
    if (entry.kind === 'tooltip' && !entry.holds(target)) {
      entry.dismiss('outside');
    }
  }
  const layers = stack.filter((entry) => entry.kind !== 'tooltip');
  const top = layers[layers.length - 1];
  if (top === undefined || inForeignModal(target, top)) return;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const entry = layers[i];
    if (entry.holds(target) || !entry.closeOnOutside()) return;
    if (entry.kind === 'modal' && entry !== top) return;
    entry.dismiss('outside');
    if (entry.kind === 'modal') return;
  }
}

/**
 * Escape belongs to the top layer. A tooltip takes it only from its own
 * trigger; one showing elsewhere (a hover hint) is hidden on the way and
 * the key goes on to the layer under it, so a field or a picker never
 * needs two presses. When focus is inside the top layer, the layer's own
 * keydown handler takes the key (after anything focused inside it, such
 * as a text field cancelling an edit); when it is in a modal surface
 * outside the stack (the command palette), that surface's; otherwise (a
 * popover that left focus in its anchor, focus fallen to <body>) the top
 * layer is dismissed here, in the capture phase, before any page listener
 * sees the key.
 */
function onStackKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) {
    return;
  }
  const target = event.target instanceof Node ? event.target : null;
  let top: LayerEntry | undefined;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry.kind !== 'tooltip') {
      top = entry;
      break;
    }
    if (target !== null && entry.holds(target)) {
      event.preventDefault();
      event.stopPropagation();
      entry.dismiss('escape');
      return;
    }
    entry.dismiss('escape');
  }
  if (top === undefined) return;
  const element = top.element();
  if (target !== null && element !== null && element.contains(target)) return;
  if (target !== null && inForeignModal(target, top)) return;
  event.preventDefault();
  event.stopPropagation();
  top.dismiss('escape');
}

/**
 * Focus left the popovers: the ones above the highest layer that holds
 * the newly focused element close (reason 'outside', so focus stays where
 * it went), as a popover does when the command palette, a dialog or the
 * composer takes focus. A modal layer stops the walk (it keeps focus
 * itself), and tooltips are left to their trigger's blur.
 */
function onStackFocusIn(event: FocusEvent): void {
  if (!(event.target instanceof Node)) return;
  const target = event.target;
  const layers = stack.slice();
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const entry = layers[i];
    if (entry.kind === 'tooltip') continue;
    if (entry.holds(target) || entry.kind === 'modal') return;
    entry.dismiss('outside');
  }
}

/** Adds an open layer. A layer that contains layers already open (a
    dialog and a tooltip inside it, mounted open together: React runs the
    child's effect first) goes beneath them. */
function addLayer(entry: LayerEntry): void {
  const element = entry.element();
  let at = stack.length;
  if (element !== null) {
    const firstInside = stack.findIndex((other) => {
      const inner = other.element();
      return inner !== null && inner !== element && element.contains(inner);
    });
    if (firstInside >= 0) at = firstInside;
  }
  stack.splice(at, 0, entry);
  if (stack.length === 1) {
    document.addEventListener('pointerdown', onStackPointerDown, true);
    document.addEventListener('keydown', onStackKeyDown, true);
    document.addEventListener('focusin', onStackFocusIn, true);
  }
}

function removeLayer(entry: LayerEntry): void {
  const at = stack.indexOf(entry);
  if (at < 0) return;
  stack.splice(at, 1);
  if (stack.length === 0) {
    document.removeEventListener('pointerdown', onStackPointerDown, true);
    document.removeEventListener('keydown', onStackKeyDown, true);
    document.removeEventListener('focusin', onStackFocusIn, true);
  }
}

interface UseLayerOptions {
  open: boolean;
  /** modal: Dialog, a modal SlideOver; popover: PickerPopover, Popover;
      tooltip: Tooltip (any press hides it, and it never takes a press
      from the layer under it). */
  kind: LayerKind;
  /** The layer's element (the popover, the dialog panel, the tooltip). */
  ref: { readonly current: HTMLElement | null };
  /** The stack dismisses the layer: 'escape' (focus outside it), or
      'outside' (a press outside it, or focus moved out of a popover;
      focus stays where it went). 'tab' is the component's own. */
  onDismiss: (reason: DismissReason) => void;
  /** A press outside dismisses it. Default true. */
  closeOnOutside?: boolean;
  /** Elements outside `ref` that count as the layer's own for presses
      and focus: its trigger or anchor, so a press there toggles instead
      of dismissing and reopening, and a tooltip's trigger, the one place
      it takes Escape from. */
  inside?: () => readonly (Element | null | undefined)[];
}

/**
 * Registers an open overlay in the package's one layer stack. While
 * `open`, a capture-phase pointerdown outside the topmost layer (and its
 * `inside` elements) dismisses it and the non-modal layers under it that
 * do not hold the press; focus moving out of a popover closes it; and an
 * Escape that does not come from inside the topmost layer dismisses it
 * with preventDefault() and stopPropagation(), so a SlideOver beneath,
 * the shell's shortcuts and a host's document listeners never see it.
 * A modal surface outside the stack (aria-modal, such as the command
 * palette) keeps its own keys and presses. The layer's own Escape
 * handler must do the same for keys from inside it. `isTop()` says
 * whether this layer is the topmost one now; `isTop(true)` looks past
 * open tooltips, which never take a press from the layer under them (a
 * modal SlideOver asks it of a press on its scrim).
 */
export function useLayer(options: UseLayerOptions): {
  isTop: (ignoreTooltips?: boolean) => boolean;
} {
  const latest = useLatest(options);
  const entryRef = useRef<LayerEntry | null>(null);
  const { open, kind } = options;

  useClientLayoutEffect(() => {
    if (!open) return undefined;
    const entry: LayerEntry = {
      kind,
      element: () => latest.current.ref.current,
      holds: (target) => {
        const own = latest.current.ref.current;
        if (own !== null && own.contains(target)) return true;
        const extra = latest.current.inside?.() ?? [];
        return extra.some(
          (element) =>
            element !== null &&
            element !== undefined &&
            element.contains(target)
        );
      },
      closeOnOutside: () => latest.current.closeOnOutside ?? true,
      dismiss: (reason) => latest.current.onDismiss(reason),
    };
    addLayer(entry);
    entryRef.current = entry;
    return () => {
      removeLayer(entry);
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [open, kind, latest]);

  return useMemo(
    () => ({
      isTop: (ignoreTooltips = false) => {
        const entry = entryRef.current;
        return entry !== null && topLayer(ignoreTooltips) === entry;
      },
    }),
    []
  );
}
