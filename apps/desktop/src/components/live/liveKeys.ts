import { CHORD_WINDOW_MS } from '../../lib/cockpitKeys';
import {
  type FlightNavIndex,
  moveFlightCursor,
} from '../flightplan/flightKeys';

// The Live view's keyboard model, pure so every key is testable without a DOM: j/k walk
// every band's nodes in reading order (wave by wave, top to bottom, band after band),
// J/K jump a band, h/l cross columns inside one.

export type LiveCommand =
  | 'next'
  | 'prev'
  | 'next-band'
  | 'prev-band'
  | 'left'
  | 'right'
  /** Enter: the task beside the bands. */
  | 'open'
  /** `o`: the full task page. */
  | 'open-full'
  | 'dispatch'
  | 'peek'
  /** Escape: close the side pane. */
  | 'close';

type LiveMove = Extract<
  LiveCommand,
  'next' | 'prev' | 'next-band' | 'prev-band' | 'left' | 'right'
>;

const KEYS: Record<string, LiveCommand> = {
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  J: 'next-band',
  K: 'prev-band',
  h: 'left',
  ArrowLeft: 'left',
  l: 'right',
  ArrowRight: 'right',
  Enter: 'open',
  o: 'open-full',
  d: 'dispatch',
  ' ': 'peek',
  Escape: 'close',
};

export interface LiveKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** When the key went down, ms. */
  at: number;
}

/**
 * One keystroke → a command. A bare `g` arms the shell's chord and resolves nothing here;
 * the key after it inside the window belongs to the shell (`g h` goes Home, never left).
 * Modified keys are someone else's shortcut.
 */
export function resolveLiveKey(
  input: LiveKeyInput,
  gArmedAt: number | null
): { command: LiveCommand | null; gArmedAt: number | null } {
  if (input.metaKey || input.ctrlKey || input.altKey) {
    return { command: null, gArmedAt: null };
  }
  if (gArmedAt !== null && input.at - gArmedAt <= CHORD_WINDOW_MS) {
    return { command: null, gArmedAt: null };
  }
  if (input.key === 'g') return { command: null, gArmedAt: input.at };
  return { command: KEYS[input.key] ?? null, gArmedAt: null };
}

/** One band as the keyboard walks it. */
export interface LiveNavBand {
  key: string;
  /** Drawn node ids in reading order. */
  order: readonly string[];
  nav: FlightNavIndex;
}

export interface LiveCursor {
  band: string;
  id: string;
}

function firstIn(
  bands: readonly LiveNavBand[],
  from: number,
  step: 1 | -1,
  end: 'first' | 'last'
): LiveCursor | null {
  for (let i = from; i >= 0 && i < bands.length; i += step) {
    const band = bands[i];
    if (band === undefined || band.order.length === 0) continue;
    const id =
      end === 'first' ? band.order[0] : band.order[band.order.length - 1];
    if (id !== undefined) return { band: band.key, id };
  }
  return null;
}

/**
 * Where the cursor really is: on its node in its band; on the same node in whichever band
 * holds it now; on the first node of its band once its node left; else the first node
 * anywhere. Null with nothing to stand on.
 */
export function settleLiveCursor(
  bands: readonly LiveNavBand[],
  cursor: LiveCursor | null
): LiveCursor | null {
  if (cursor !== null) {
    const home = bands.find((b) => b.key === cursor.band);
    if (home?.order.includes(cursor.id) === true) return cursor;
    const moved = bands.find((b) => b.order.includes(cursor.id));
    if (moved !== undefined) return { band: moved.key, id: cursor.id };
    const first = home?.order[0];
    if (home !== undefined && first !== undefined) {
      return { band: home.key, id: first };
    }
  }
  return firstIn(bands, 0, 1, 'first');
}

/**
 * Where a move lands. `next`/`prev` step through the reading order, running on into the
 * adjacent band at either end; `next-band`/`prev-band` land on a band's first node;
 * `left`/`right` hop columns inside the band. No cursor yet starts on the first node.
 * A move with nowhere to go stays put.
 */
export function moveLiveCursor(
  bands: readonly LiveNavBand[],
  cursor: LiveCursor | null,
  command: LiveMove
): LiveCursor | null {
  const here = settleLiveCursor(bands, cursor);
  if (here === null || cursor === null) return here;
  const index = bands.findIndex((b) => b.key === here.band);
  const band = bands[index];
  if (band === undefined) return here;
  const position = band.order.indexOf(here.id);
  switch (command) {
    case 'next': {
      const id = band.order[position + 1];
      if (id !== undefined) return { band: band.key, id };
      return firstIn(bands, index + 1, 1, 'first') ?? here;
    }
    case 'prev': {
      const id = position > 0 ? band.order[position - 1] : undefined;
      if (id !== undefined) return { band: band.key, id };
      return firstIn(bands, index - 1, -1, 'last') ?? here;
    }
    case 'next-band':
      return firstIn(bands, index + 1, 1, 'first') ?? here;
    case 'prev-band':
      return firstIn(bands, index - 1, -1, 'first') ?? here;
    case 'left':
    case 'right': {
      const id = moveFlightCursor(band.nav, here.id, command);
      return id === null ? here : { band: band.key, id };
    }
  }
}
