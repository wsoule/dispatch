import { useCallback, useEffect, useRef } from 'react';

interface Handoff {
  id: string;
  index: number;
}

/**
 * Where the cursor goes once `from`'s row may have moved: nowhere (`undefined`) while the
 * row is still at its place, else to the row that took it — or the last, or none.
 */
export function handoffTarget(
  ids: readonly string[],
  from: Handoff
): string | null | undefined {
  if (ids[from.index] === from.id) return undefined;
  if (ids.length === 0) return null;
  return ids[Math.min(from.index, ids.length - 1)] ?? null;
}

/**
 * The Cockpit's rule for a row that leaves, for views that regroup instead: call the
 * returned `handOff(id)` just before an action that moves the cursor's row (a dispatch
 * sends it to another status group), and once the order changes the row that took its
 * place gets the cursor, so `d` `d` `d` walks down a list rather than chasing one task.
 */
export function useCursorHandoff(
  orderedIds: readonly string[],
  setCursor: (id: string | null) => void
): (id: string) => void {
  const pending = useRef<Handoff | null>(null);
  // After every render, so a handoff never outlives the action that asked for it.
  useEffect(() => {
    const from = pending.current;
    if (from === null) return;
    pending.current = null;
    const next = handoffTarget(orderedIds, from);
    if (next !== undefined) setCursor(next);
  });
  return useCallback(
    (id: string) => {
      const index = orderedIds.indexOf(id);
      pending.current = index === -1 ? null : { id, index };
    },
    [orderedIds]
  );
}
