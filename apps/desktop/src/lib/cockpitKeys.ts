import { COCKPIT_LANES, type CockpitLaneId } from './cockpit';
import { stepKey } from './virtualRows';

// The Cockpit's keyboard model, pure so every key is testable without a DOM: which command
// a keystroke is, and where the cursor lands after a move.

type CockpitCommand =
  | 'down'
  | 'up'
  | 'left'
  | 'right'
  /** Enter: open the row's task in the split pane. */
  | 'open-split'
  /** `o`: the full task page. */
  | 'open-full'
  /** Space: the peek dialog. */
  | 'peek'
  /** `d`: dispatch the focused Ready row. */
  | 'dispatch'
  /** `t`: flip between your work and the team's. */
  | 'toggle-team'
  /** `g p`: group every lane by person. */
  | 'roster'
  /** Escape: close the split pane. */
  | 'close';

const KEYS: Record<string, CockpitCommand> = {
  j: 'down',
  ArrowDown: 'down',
  k: 'up',
  ArrowUp: 'up',
  h: 'left',
  ArrowLeft: 'left',
  l: 'right',
  ArrowRight: 'right',
  Enter: 'open-split',
  o: 'open-full',
  ' ': 'peek',
  d: 'dispatch',
  t: 'toggle-team',
  Escape: 'close',
};

/** How long a bare `g` waits for its second key — the shell's chord window. */
export const CHORD_WINDOW_MS = 600;

export interface CockpitKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  /** When the key went down, ms. */
  at: number;
}

export interface CockpitKeyResult {
  command: CockpitCommand | null;
  /** When a bare `g` armed the chord, or null. */
  gArmedAt: number | null;
}

/**
 * One keystroke → a command. A bare `g` arms the chord and resolves nothing (the shell's own
 * `g` handler sees it too); `p` inside the window is the roster. Any other second key is left
 * alone so the shell's `g s`, `g i`… still go where they go, and never doubles as a Cockpit
 * key. Modified keys are someone else's shortcut.
 */
export function resolveCockpitKey(
  input: CockpitKeyInput,
  gArmedAt: number | null
): CockpitKeyResult {
  if (input.metaKey || input.ctrlKey) return { command: null, gArmedAt: null };
  const armed = gArmedAt !== null && input.at - gArmedAt <= CHORD_WINDOW_MS;
  if (armed) {
    return {
      command: input.key === 'p' ? 'roster' : null,
      gArmedAt: null,
    };
  }
  if (input.key === 'g') return { command: null, gArmedAt: input.at };
  return { command: KEYS[input.key] ?? null, gArmedAt: null };
}

export interface CockpitCursor {
  lane: CockpitLaneId;
  /** The focused row's key within the lane, or null when the lane is empty. */
  key: string | null;
}

/**
 * Where a move lands. Up and down step within the lane (over item rows only — `laneKeys`
 * never holds a roster header). Left and right hop to the nearest lane with rows in that
 * direction, keeping the same position down the lane as nearly as it has one.
 */
export function moveCockpitCursor(
  laneKeys: Readonly<Record<CockpitLaneId, readonly string[]>>,
  cursor: CockpitCursor,
  command: 'down' | 'up' | 'left' | 'right'
): CockpitCursor {
  if (command === 'down' || command === 'up') {
    return {
      lane: cursor.lane,
      key: stepKey(
        laneKeys[cursor.lane],
        cursor.key,
        command === 'down' ? 1 : -1
      ),
    };
  }
  const from = COCKPIT_LANES.indexOf(cursor.lane);
  const step = command === 'right' ? 1 : -1;
  const position = Math.max(
    0,
    cursor.key === null ? 0 : laneKeys[cursor.lane].indexOf(cursor.key)
  );
  for (let i = from + step; i >= 0 && i < COCKPIT_LANES.length; i += step) {
    const lane = COCKPIT_LANES[i];
    if (lane === undefined) break;
    const keys = laneKeys[lane];
    if (keys.length === 0) continue;
    return { lane, key: keys[Math.min(position, keys.length - 1)] ?? null };
  }
  return cursor;
}
