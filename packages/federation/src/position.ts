import { compareHlc, parseOpHlc } from '@dispatch/protocol/federation';

/** Where an op sits in fold order. */
export interface Position {
  hlc: string;
  replica: string;
  seq: number;
}

// Fold order: (hlc numerically, replica, seq). Unique, since (replica, seq) is;
// an unreadable hlc sorts after every readable one, so the order stays total.
export function comparePositions(a: Position, b: Position): number {
  const ca = parseOpHlc(a.hlc);
  const cb = parseOpHlc(b.hlc);
  if (ca !== null && cb !== null) {
    const byClock = compareHlc(ca, cb);
    if (byClock !== 0) return byClock;
  } else if (ca !== cb) {
    return ca === null ? 1 : -1;
  }
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.seq - b.seq;
}
