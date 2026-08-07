import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

/** A selected span of code in a diff: which file, which lines, and the text itself. This is a
 * UI concept distinct from `Snippet` (the persisted attachment a later step turns it into). */
export interface CodeSelection {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Where to put the bar, in the coordinate space of whatever element it is rendered inside.
 *
 * Measured from the rendered rows the selection crosses rather than from the selection itself: a
 * `Range` spanning a shadow boundary is exactly what made the earlier positioning both
 * untestable and, in the app, silently absent, while an element's own
 * `getBoundingClientRect()` behaves the same either side of a shadow root.
 */
export interface SelectionAnchor {
  /** Top of the first crossed row — the bar hangs above this. */
  top: number;
  /** Bottom of the last crossed row — where the bar drops to when there is no room above. */
  bottom: number;
  left: number;
  /** Of the container, so the bar can be kept from running off its right edge. */
  width: number;
}

/** One control on the floating action bar. The caller supplies the full action — label, icon,
 * and handler — so this file never has to know what "add to chat" or "copy" means. */
export interface SelectionAction {
  id: string;
  label: string;
  icon: ReactNode;
  onInvoke(selection: CodeSelection): void;
}

interface SelectionActionsProps {
  selection: CodeSelection | null;
  /** `null` renders the bar unpositioned rather than not at all — a visible control in the wrong
   * place is still reachable, an absent one is not. */
  anchor: SelectionAnchor | null;
  actions: SelectionAction[];
}

// The bar is one row of small buttons; these are what it takes up before it renders, which is
// the only moment its placement can be decided from. Approximate on purpose: they decide
// above-vs-below and how far left to pull the bar, and being a few pixels out costs nothing,
// while measuring would mean rendering it somewhere wrong first.
const BAR_HEIGHT = 40;
const BAR_WIDTH = 260;

/**
 * Floating action bar shown over a code selection. Deliberately diff-agnostic: it takes its
 * actions and its position as data from the caller and knows nothing about chat, comments, runs,
 * or Pierre. That split is what lets this render in a test with no server, no run, and no Pierre.
 *
 * Placement follows the same shape as Pierre's own editor widget: prefer above the selection,
 * drop below it when there is no room, and never let it run off the side.
 */
export function SelectionActions({
  selection,
  anchor,
  actions,
}: SelectionActionsProps) {
  if (selection === null) return null;

  // Above the first row unless it would be clipped by the top of the container, in which case
  // below the last row — the same preference/fallback the editor's own widget uses.
  const placeAbove = anchor !== null && anchor.top >= BAR_HEIGHT;
  const style =
    anchor === null
      ? undefined
      : {
          top: placeAbove ? anchor.top : anchor.bottom,
          left: Math.max(0, Math.min(anchor.left, anchor.width - BAR_WIDTH)),
        };

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className={cn(
        'bg-popover absolute z-50 flex gap-1 rounded-md border p-1 shadow-md',
        placeAbove && '-translate-y-full'
      )}
      style={style}
    >
      {actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => action.onInvoke(selection)}
        >
          {action.icon}
          {action.label}
        </Button>
      ))}
    </div>
  );
}
