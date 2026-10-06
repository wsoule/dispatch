import type { JsonValue } from '@dispatch-foo/protocol';
import {
  buildOp,
  fingerprint,
  generateReplicaKeys,
  opHash,
  sha256Hex,
  stubOf,
  ZERO_HASH,
} from '@dispatch-foo/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch-foo/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { printable, verifyLog } from '../src/verify.js';

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

// The default key op with some body fields replaced, signed by `keys`.
function keyOpWith(changes: Record<string, JsonValue>): FederatedOp {
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
        signPub: keys.signPub,
        sealPub: keys.sealPub,
        legacy: null,
        ...changes,
      },
    },
    keys.signPriv
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

  it('halts when a pinned replica shows its key op with any field changed', () => {
    const first = verifyLog(R, log(1), fresh, null);
    const changes: Record<string, JsonValue>[] = [
      { sealPub: generateReplicaKeys().sealPub },
      { handle: 'eve' },
      { device: 'desk' },
      { build: '0.41.0' },
      { legacy: { throughSeq: 3, digest: sha256Hex('v1') } },
      { invite: { id: 'inv-1', sig: 'sig' } },
    ];
    for (const change of changes) {
      const r = verifyLog(R, [keyOpWith(change)], fresh, first.pinned);
      expect(r.accepted).toEqual([]);
      expect(r.pinned).toBeNull();
      expect(r.problem).toContain('a different key');
      expect(r.cursor.halted).toBe(r.problem);
    }
  });

  it('reads the pinned key op again without pinning it twice', () => {
    const first = verifyLog(R, log(1), fresh, null);
    const r = verifyLog(R, log(3), fresh, first.pinned);
    expect(r.accepted.map((a) => a.entry.seq)).toEqual([1, 2, 3]);
    expect(r.pinned).toBeNull();
    expect(r.problem).toBeNull();
  });

  it('halts on anything placed before the key op', () => {
    const junk = { replica: R, seq: 0 } as unknown as LogEntry;
    const r = verifyLog(R, [junk, ...log(2)], fresh, null);
    expect(r.accepted).toEqual([]);
    expect(r.pinned).toBeNull();
    expect(r.cursor.halted).toContain(
      'fails verification at seq 0: a log must start with its key op'
    );
  });

  it('halts on a stub of the key op or a key op with no signing key', () => {
    for (const bad of [stubOf(keyOp()), keyOpWith({ signPub: 5 })]) {
      const r = verifyLog(R, [bad, ...log(2).slice(1)], fresh, null);
      expect(r.accepted).toEqual([]);
      expect(r.cursor.halted).toContain('fails verification at seq 1');
      expect(r.problem).toBe(r.cursor.halted);
    }
  });

  it('carries a well-formed legacy and invite onto the pin', () => {
    const legacy = { throughSeq: 12, digest: sha256Hex('v1') };
    const invite = { id: 'inv-1', sig: 'sig' };
    const r = verifyLog(R, [keyOpWith({ legacy, invite })], fresh, null);
    expect(r.pinned?.legacy).toEqual(legacy);
    expect(r.pinned?.invite).toEqual(invite);
  });

  it('halts on a key op whose legacy or invite is malformed', () => {
    const digest = sha256Hex('v1');
    const bad: Record<string, JsonValue>[] = [
      { legacy: { throughSeq: -1, digest } },
      { legacy: { throughSeq: 1.5, digest } },
      { legacy: { throughSeq: 1, digest: 'not a digest' } },
      { legacy: { throughSeq: 1, digest: digest.toUpperCase() } },
      { legacy: [] },
      { invite: null },
      { invite: { id: 1, sig: 'sig' } },
      // M1: a handle off the grammar, and a device or build with control
      // characters or past the cap, are not printable anywhere.
      { handle: 'Ada Lovelace' },
      { handle: 'a'.repeat(65) },
      { device: 'desk\u001b[2J' },
      { device: 'd'.repeat(129) },
      { build: '0.40.0\n' },
      { build: '' },
    ];
    for (const change of bad) {
      const r = verifyLog(R, [keyOpWith(change)], fresh, null);
      expect(r.pinned).toBeNull();
      expect(r.cursor.halted).toContain('seq 1: malformed key op');
    }
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

describe('printable', () => {
  it('drops C0 and C1 controls and caps the length', () => {
    expect(printable('desk\u001b[2J\u009bx')).toBe('desk[2Jx');
    expect(printable('d'.repeat(200))).toHaveLength(128);
    expect(printable('laptop')).toBe('laptop');
  });
});
