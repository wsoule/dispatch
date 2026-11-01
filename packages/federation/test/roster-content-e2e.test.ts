import { describe, expect, it } from 'bun:test';

import { KNOWN_ROSTER_PAIRS } from '../src/roster.js';
import { admit, keysFor, op, pausedAt, revoke, team } from './rosterOps.js';

const A = 'ada-0000000a';
const B = 'bo-0000000b';
const C = 'cy-0000000c';
const D = 'di-0000000d';
const t = team(A, keysFor([A, B, C, D]));
const on = (by: string, seq: number, ms: number) =>
  op(by, seq, ms, { action: 'content-e2e' });

// B is an admin, C and D members.
const BASE = [
  admit(A, 2, 100, B, 'admin'),
  admit(A, 3, 110, C),
  admit(A, 4, 120, D),
];

describe('the content-e2e switch', () => {
  it('is off until an admin switches it', () => {
    expect(t.fold(BASE).contentE2e).toBeNull();
    const sw = on(B, 2, 200);
    expect(t.fold([...BASE, sw]).contentE2e).toEqual({
      since: sw.hash,
      epochs: [sw.hash],
    });
  });

  it('ignores a member’s switch', () => {
    const sw = on(C, 2, 200);
    const v = t.fold([...BASE, sw]);
    expect(v.contentE2e).toBeNull();
    expect(v.problems.map((p) => p.message)).toContain(
      `${C} lacks the right to content-e2e at seq 2; ignored`
    );
  });

  it('keeps the first switch when admins send two', () => {
    const first = on(A, 5, 200);
    const second = on(B, 2, 300);
    expect(t.fold([...BASE, second, first]).contentE2e?.since).toBe(first.hash);
  });

  it('opens an epoch at each accepted revoke after the switch, in fold order', () => {
    const before = revoke(A, 5, 150, D, 1);
    const sw = on(A, 6, 200);
    const cutC = revoke(A, 7, 300, C, 1);
    const refused = revoke(C, 2, 250, B, 1); // a member may not revoke an admin
    const v = t.fold([...BASE, cutC, refused, sw, before]);
    expect(v.revoked.has(D)).toBe(true);
    expect(v.revoked.has(B)).toBe(false);
    expect(v.contentE2e).toEqual({
      since: sw.hash,
      epochs: [sw.hash, cutC.hash],
    });
  });

  it('folds the same for the relay', () => {
    const sw = on(A, 5, 200);
    const cut = revoke(B, 2, 300, C, 1);
    const ops = [...BASE, sw, cut];
    expect(t.fold(ops, { relay: true }).contentE2e).toEqual(
      t.fold(ops).contentE2e
    );
    expect(t.fold(ops).contentE2e?.epochs).toEqual([sw.hash, cut.hash]);
  });

  it('is a Known(1) pair here, while a later rv still pauses a daemon but not the relay', () => {
    expect(KNOWN_ROSTER_PAIRS.has('content-e2e@1')).toBe(true);
    const later = op(A, 5, 200, { rv: 2, action: 'content-e2e' });
    expect(t.fold([...BASE, later]).unknown).toEqual(pausedAt(later));
    expect(t.fold([...BASE, later], { relay: true }).unknown).toBeNull();
    expect(t.fold([...BASE, later]).contentE2e).toBeNull();
  });
});
