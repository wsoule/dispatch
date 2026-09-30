import type { FlightBox } from './flightLayout';

// Keyboard movement over the Flight Plan's grid: up/down walk a column, left/right hop to
// the next column that has nodes, landing on the node nearest the same height.

export type FlightDirection = 'up' | 'down' | 'left' | 'right';

export type FlightCommand =
  | FlightDirection
  | 'open'
  | 'open-full'
  | 'dispatch'
  | 'peek'
  | 'close';

/** Node ids per column, top to bottom, and each node's column and row in it. */
export interface FlightNavIndex {
  columns: string[][];
  at: ReadonlyMap<string, { column: number; row: number; y: number }>;
}

/** Built once per layout. Empty columns are dropped, so a hop never lands in a gap. */
export function flightNavIndex(
  boxes: ReadonlyMap<string, FlightBox>
): FlightNavIndex {
  const byColumn = new Map<number, FlightBox[]>();
  for (const box of boxes.values()) {
    const bucket = byColumn.get(box.column);
    if (bucket === undefined) byColumn.set(box.column, [box]);
    else bucket.push(box);
  }
  const columns: string[][] = [];
  const at = new Map<string, { column: number; row: number; y: number }>();
  for (const key of [...byColumn.keys()].sort((a, b) => a - b)) {
    const sorted = (byColumn.get(key) ?? []).sort(
      (a, b) => a.y - b.y || a.id.localeCompare(b.id)
    );
    const column = columns.length;
    columns.push(sorted.map((b) => b.id));
    sorted.forEach((b, row) => at.set(b.id, { column, row, y: b.y }));
  }
  return { columns, at };
}

/** Where the cursor goes from `current`; no cursor starts at the top-left node. */
export function moveFlightCursor(
  index: FlightNavIndex,
  current: string | null,
  direction: FlightDirection
): string | null {
  const here = current === null ? undefined : index.at.get(current);
  if (here === undefined) return index.columns[0]?.[0] ?? null;
  const column = index.columns[here.column] ?? [];
  switch (direction) {
    case 'up':
      return column[Math.max(0, here.row - 1)] ?? current;
    case 'down':
      return column[Math.min(column.length - 1, here.row + 1)] ?? current;
    case 'left':
    case 'right': {
      const next = index.columns[here.column + (direction === 'left' ? -1 : 1)];
      if (next === undefined || next.length === 0) return current;
      let best = next[0] ?? null;
      let bestGap = Infinity;
      for (const id of next) {
        const gap = Math.abs((index.at.get(id)?.y ?? 0) - here.y);
        if (gap < bestGap) {
          bestGap = gap;
          best = id;
        }
      }
      return best;
    }
  }
}

/** The command a keystroke means on the Flight Plan, or null to let it through. */
export function resolveFlightKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): FlightCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowUp':
    case 'k':
      return 'up';
    case 'ArrowDown':
    case 'j':
      return 'down';
    case 'ArrowLeft':
    case 'h':
      return 'left';
    case 'ArrowRight':
    case 'l':
      return 'right';
    case 'Enter':
      return 'open';
    case 'o':
      return 'open-full';
    case 'd':
      return 'dispatch';
    case ' ':
      return 'peek';
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}
