// Where a picker's popover goes: pure geometry, so it is testable without a
// browser and shared by every popover in the family. No library: below the
// trigger by default, above it when there is more room there and the
// popover does not fit below, and slid left so it never leaves the viewport.

export interface PlacementInput {
  /** The trigger's box in viewport coordinates (getBoundingClientRect). */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** The popover's natural size (capped by its CSS max-height). */
  size: { width: number; height: number };
  /** The visible viewport. */
  viewport: { width: number; height: number };
  /** Space between the trigger and the popover. Default 4. */
  gap?: number;
  /** Space kept clear at the viewport's edges. Default 8. */
  margin?: number;
  /** Which trigger edge the popover lines up with. Default 'start' (left
      edges); 'end' lines up the right edges, for a trigger at the right
      of its row. Either flips when the popover would leave the viewport. */
  align?: 'start' | 'end';
}

export interface Placement {
  side: 'below' | 'above';
  /** CSS left, px. */
  left: number;
  /** below: CSS top, px (from the viewport's top). */
  top: number | null;
  /** above: CSS bottom, px (from the viewport's bottom), so the popover
      stays pinned to the trigger as its list grows or shrinks. */
  bottom: number | null;
  /** Height available on the chosen side, px; the list scrolls inside. */
  maxHeight: number;
  /** Width after clamping to the viewport, px. */
  width: number;
}

/**
 * Places a popover against its trigger. Below wins unless the popover does
 * not fit there and the space above is larger (it flips at the bottom
 * edge). Horizontally it lines up with the trigger's left edge (or right
 * edge with align 'end'); when that leaves the viewport it lines up with
 * the other edge instead, and it is finally clamped inside the margins.
 */
export function placePopover(input: PlacementInput): Placement {
  const gap = input.gap ?? 4;
  const margin = input.margin ?? 8;
  const { anchor, size, viewport } = input;

  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const side: Placement['side'] =
    size.height <= below || below >= above ? 'below' : 'above';
  const maxHeight = Math.max(0, Math.floor(side === 'below' ? below : above));

  const width = Math.max(0, Math.min(size.width, viewport.width - 2 * margin));
  let left: number;
  if (input.align === 'end') {
    left = anchor.right - width;
    if (left < margin) left = anchor.left;
  } else {
    left = anchor.left;
    if (left + width > viewport.width - margin) left = anchor.right - width;
  }
  left = Math.min(left, viewport.width - margin - width);
  left = Math.max(left, margin);

  return {
    side,
    left: Math.round(left),
    top: side === 'below' ? Math.round(anchor.bottom + gap) : null,
    bottom:
      side === 'above' ? Math.round(viewport.height - anchor.top + gap) : null,
    maxHeight,
    width,
  };
}
