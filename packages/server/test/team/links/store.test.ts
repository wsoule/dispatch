import {
  buildOp,
  generateReplicaKeys,
  opHash,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LinkStore,
  MAX_PARKED_PER_PUBLISHER,
} from '../../../src/team/links/store.js';

const R = 'a2a-0000000a';
const keys = generateReplicaKeys();
const op = (seq: number, body: string) =>
  buildOp(
    {
      replica: R,
      seq,
      prev: ZERO_HASH,
      hlc: `1791201600000.${String(seq).padStart(4, '0')}.${R}`,
      type: 'key',
      body: { b: body },
    },
    keys.signPriv
  );

let dir: string;
let store: LinkStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function open() {
  dir = mkdtempSync(join(tmpdir(), 'link-store-'));
  store = new LinkStore(join(dir, 'link.db'), () => new Date(0));
  return store;
}

describe('LinkStore (FW-R36, FW-R37)', () => {
  it('keeps the first verified hash for a seq forever', () => {
    const st = open();
    st.keep(R, 2, 'aa');
    st.keep(R, 2, 'bb');
    expect(st.kept(R, 2)).toBe('aa');
  });

  it('re-stages a parked op only while it matches its kept hash', () => {
    const st = open();
    const a = op(1, 'a');
    const b = op(2, 'b');
    st.keep(R, 1, opHash(a));
    st.keep(R, 2, 'not-this-op');
    st.park(a);
    st.park(b);
    expect(st.parked(R).map((o) => o.seq)).toEqual([1]);
    // The mismatched one is gone, not kept for later.
    expect(st.parked(R).map((o) => o.seq)).toEqual([1]);
  });

  it('caps parked ops per publisher', () => {
    const st = open();
    for (let i = 1; i <= MAX_PARKED_PER_PUBLISHER; i++)
      expect(st.park({ ...op(1, 'x'), seq: i })).toBe(true);
    expect(st.park({ ...op(1, 'x'), seq: MAX_PARKED_PER_PUBLISHER + 1 })).toBe(
      false
    );
  });
});
