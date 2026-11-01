'use client';

import { useEffect, useLayoutEffect } from 'react';

import { placePopover } from '../edit/position';
import { useLatest } from '../edit/save-state';

// Shared by Menu, Popover and Tooltip: the top layer, placement that
// follows scrolling, and dismissal by a press outside.

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type ElementRef = { readonly current: HTMLElement | null };

/** Shows a `popover="manual"` element in the top layer when supported, so
    no host overflow, transform or z-index clips it. */
export function showInTopLayer(layer: HTMLElement): void {
  if (typeof layer.showPopover !== 'function') return;
  try {
    if (!layer.matches(':popover-open')) layer.showPopover();
  } catch {
    // An engine without :popover-open, or a detached node: the fixed
    // fallback still positions it.
  }
}

/** The visible viewport, without a classic scroll bar's width. */
function viewportSize(): { width: number; height: number } {
  const clientWidth = document.documentElement.clientWidth;
  return {
    width: clientWidth > 0 ? clientWidth : window.innerWidth,
    height: window.innerHeight,
  };
}

/** Places `layer` below `anchor` (or above for side 'above'), flipping when
    short of room; corrects for a transformed ancestor outside the top layer. */
export function placeLayer(
  layer: HTMLElement,
  anchor: HTMLElement,
  align: 'start' | 'end',
  side: 'below' | 'above',
  gap = 4
): void {
  const rect = anchor.getBoundingClientRect();
  const viewport = viewportSize();
  const size = { width: layer.offsetWidth, height: layer.offsetHeight };
  const placement = placePopover({ anchor: rect, size, viewport, align, gap });
  const roomAbove = rect.top - gap - 8;
  let top: number;
  let maxHeight = placement.maxHeight;
  if (
    side === 'above' &&
    (size.height <= roomAbove || placement.side === 'above')
  ) {
    maxHeight = Math.max(0, Math.floor(roomAbove));
    top = Math.round(rect.top - gap - Math.min(size.height, maxHeight));
  } else if (placement.side === 'above') {
    top = Math.round(rect.top - gap - Math.min(size.height, maxHeight));
  } else {
    top = placement.top ?? Math.round(rect.bottom + gap);
  }
  const style = layer.style;
  style.left = `${placement.left}px`;
  style.top = `${top}px`;
  style.maxHeight = `${maxHeight}px`;
  const landed = layer.getBoundingClientRect();
  if (landed.width > 0 || landed.height > 0) {
    const dx = landed.left - placement.left;
    const dy = landed.top - top;
    if (Math.abs(dx) > 0.5) style.left = `${placement.left - dx}px`;
    if (Math.abs(dy) > 0.5) style.top = `${top - dy}px`;
  }
  layer.dataset.placed = 'true';
}

/** While open, keeps the layer in the top layer and placed against its
    anchor, re-placing it on resize and outside scrolls. */
export function useAnchoredLayer(
  open: boolean,
  layerRef: ElementRef,
  anchorRef: ElementRef,
  align: 'start' | 'end',
  side: 'below' | 'above' = 'below'
): void {
  useClientLayoutEffect(() => {
    if (!open) return undefined;
    const layer = layerRef.current;
    if (layer === null) return undefined;
    showInTopLayer(layer);
    let frame = 0;
    const place = (): void => {
      frame = 0;
      const anchor = anchorRef.current;
      if (anchor !== null) placeLayer(layer, anchor, align, side);
    };
    place();
    const schedule = (event?: Event): void => {
      if (event?.target instanceof Node && layer.contains(event.target)) {
        return;
      }
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  }, [open, layerRef, anchorRef, align, side]);
}

/** While `open`, a pointer press outside every one of `refs` calls
    `onDismiss` (focus goes wherever the pointer went). */
export function useDismissOutside(
  open: boolean,
  refs: readonly ElementRef[],
  onDismiss: () => void
): void {
  // The latest refs and callback, so the listener is bound once per open.
  const latest = useLatest({ refs, onDismiss });
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Node)) return;
      const target = event.target;
      const { refs: current, onDismiss: dismiss } = latest.current;
      if (current.some((ref) => ref.current?.contains(target) === true)) {
        return;
      }
      dismiss();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, latest]);
}
