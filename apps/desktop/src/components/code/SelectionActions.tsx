import type { ReactNode, RefObject } from 'react';

import { useShadowSelectionRect } from './useShadowSelectionRect';
import { Button } from '@/ui/button';

/** A selected span of code in a diff: which file, which lines, and the text itself. This is a
 * UI concept distinct from `Snippet` (the persisted attachment a later step turns it into). */
export interface CodeSelection {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
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
  containerRef: RefObject<HTMLElement | null>;
  selection: CodeSelection | null;
  actions: SelectionAction[];
}

/**
 * Floating action bar shown over a code selection. Deliberately diff-agnostic: it takes its
 * actions as data from the caller and knows nothing about chat, comments, runs, or Pierre — that
 * knowledge lives entirely in `useShadowSelectionRect` and in whatever `onInvoke` callbacks the
 * caller passes in. That split is what lets this render in a test with no server, no run, and no
 * Pierre.
 */
export function SelectionActions({
  containerRef,
  selection,
  actions,
}: SelectionActionsProps) {
  const rect = useShadowSelectionRect(containerRef);

  if (selection === null) return null;

  // `rect` is null under happy-dom (no layout) and, defensively, whenever the shadow-DOM
  // geometry can't be resolved. The bar still renders — just unpositioned — rather than
  // disappearing, since a caller-visible action bar is more useful than none.
  const style =
    rect === null
      ? undefined
      : {
          top: rect.top,
          left: rect.left,
        };

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="bg-popover absolute z-50 flex -translate-y-full gap-1 rounded-md border p-1 shadow-md"
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
