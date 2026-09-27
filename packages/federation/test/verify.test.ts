import {
  buildOp,
  fingerprint,
  generateReplicaKeys,
  opHash,
  stubOf,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { verifyLog } from '../src/verify.js';

const R = 'ada-0000000a';
const keys = generateReplicaKeys();
const hlc = (ms: number) => `${String(ms).padStart(13, '0')}.0000.${R}`;

function keyOp(
  signPub = keys.signPub,
  sealPub = keys.sealPub,
  signPriv = keys.signPriv
): FederatedOp {
  return buildOp(
    {
      replica: R,
      seq: 1,
      prev: ZERO_HASH,
      hlc: hlc(1000),
      type: 'key',
      body: {
        handle: 'ada',
        device: 'laptop',
        build: '0.40.0',
        signPub,
        sealPub,
        legacy: null,
      },
    },
    signPriv
  );
}

function log(n: number): FederatedOp[] {
  const ops: FederatedOp[] = [keyOp()];
  for (let seq = 2; seq <= n; seq++) {
    ops.push(
      buildOp(
        {
          replica: R,
          seq,
          prev: opHash(ops[ops.length - 1]),
          hlc: hlc(1000 + seq),
          type: 'task',
          body: { task: 't-00000a01', kind: 'put', fields: { n: seq } },
        },
        keys.signPriv
      )
    );
  }
  return ops;
}

// A second op at seq 3, linked to the same seq 2 as the first.
function forkOf(ops: FederatedOp[]): FederatedOp {
  return buildOp(
    {
      replica: R,
      seq: 3,
      prev: opHash(ops[1]),
      hlc: hlc(2000),
      type: 'task',
      body: { task: 't-00000a01', kind: 'put', fields: { n: 99 } },
    },
    keys.signPriv
  );
}

const fresh = { head: null, halted: null };

describe('verifyLog', () => {
  it('pins the key op and accepts the chain after it', () => {
    const r = verifyLog(R, log(4), fresh, null);
    expect(r.accepted.map((a) => a.entry.seq)).toEqual([1, 2, 3, 4]);
    expect(r.pinned).toEqual({
      replica: R,
      handle: 'ada',
      device: 'laptop',
      build: '0.40.0',
      signPub: keys.signPub,
      sealPub: keys.sealPub,
      fingerprint: fingerprint(keys.signPub, keys.sealPub),
      keySeq: 1,
      legacy: null,
    });
    expect(r.cursor.head?.seq).toBe(4);
    expect(r.accepted[3]?.hash).toBe(opHash(log(4)[3]));
    expect(r.problem).toBeNull();
  });

  it('accepts an unsorted, duplicated delivery and skips what it already read', () => {
    const ops = log(4);
    const first = verifyLog(R, ops.slice(0, 2), fresh, null);
    const again = verifyLog(
      R,
      [ops[3], ops[1], ops[2], ops[2]],
      first.cursor,
      first.pinned
    );
    expect(again.accepted.map((a) => a.entry.seq)).toEqual([3, 4]);
    expect(again.pinned).toBeNull();
  });

  it('waits, cursor unmoved, for a publisher with no key op yet', () => {
    const r = verifyLog(R, log(3).slice(1), fresh, null);
    expect(r.accepted).toEqual([]);
    expect(r.cursor).toEqual(fresh);
    expect(r.problem).toBeNull();
  });

  it('halts at a fork and stays halted', () => {
    const ops = log(3);
    const forked = forkOf(ops);
    const first = verifyLog(R, ops, fresh, null);
    const r = verifyLog(R, [forked], first.cursor, first.pinned);
    expect(r.cursor.halted).toContain('fails verification at seq 3');
    expect(r.problem).toContain('revoke it, or have it push again');
    expect(
      verifyLog(R, log(5).slice(3), r.cursor, first.pinned).accepted
    ).toEqual([]);
  });

  it('accepts the ops before a fork delivered with it, then halts there', () => {
    const ops = log(3);
    const forked = forkOf(ops);
    const r = verifyLog(R, [...ops, forked], fresh, null);
    expect(r.accepted.map((a) => a.entry.seq)).toEqual([1, 2]);
    expect(r.cursor.head?.seq).toBe(2);
    expect(r.cursor.halted).toBe(
      `${R}'s log fails verification at seq 3: two ops share this seq; revoke it, or have it push again`
    );
  });

  it('halts on a stub of a board op', () => {
    const ops = log(3);
    const r = verifyLog(R, [ops[0], stubOf(ops[1])], fresh, null);
    expect(r.cursor.halted).toContain('a task op cannot be a stub');
    expect(r.accepted.map((a) => a.entry.seq)).toEqual([1]);
  });

  it('halts when a pinned replica shows another key', () => {
    const other = generateReplicaKeys();
    const first = verifyLog(R, log(1), fresh, null);
    const rekey = keyOp(other.signPub, other.sealPub, other.signPriv);
    const r = verifyLog(R, [rekey], { head: null, halted: null }, first.pinned);
    expect(r.accepted).toEqual([]);
    expect(r.problem).toContain('a different key');
    expect(r.cursor.halted).toBe(r.problem);
  });

  it('halts on a key op whose body is not a key', () => {
    const r = verifyLog(R, [keyOp(keys.signPub, 'short')], fresh, null);
    expect(r.accepted).toEqual([]);
    expect(r.pinned).toBeNull();
    expect(r.cursor.halted).toContain('fails verification at seq 1');
  });

  it('ignores other replicas and never throws on what the branch holds', () => {
    const ops = log(3);
    const junk = [
      { ...ops[2], seq: Number.POSITIVE_INFINITY },
      { ...ops[2], hlc: 5 },
      null,
      { ...ops[1], replica: 'bob-0000000b' },
    ] as unknown as LogEntry[];
    const r = verifyLog(R, [ops[0], ops[1], ...junk], fresh, null);
    expect(r.accepted.map((a) => a.entry.seq)).toEqual([1, 2]);
    expect(r.cursor.halted).toContain('fails verification at seq 3');
  });
});
