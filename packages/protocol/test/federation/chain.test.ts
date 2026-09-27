import { describe, expect, it } from 'bun:test';

import { buildOp, verifyEntry } from '../../src/federation/chain.js';
import type { ChainHead } from '../../src/federation/chain.js';
import { fingerprint } from '../../src/federation/fingerprint.js';
import { generateReplicaKeys } from '../../src/federation/keys.js';
import { opHash, stubOf, ZERO_HASH } from '../../src/federation/ops.js';
import type { FederatedOp, LogEntry } from '../../src/federation/ops.js';
import { sealPayload } from '../../src/federation/seal.js';

const R = 'ada-0000000a';
const keys = generateReplicaKeys();
const peer = generateReplicaKeys();
const hlc = (ms: number, counter = 0, replica = R) =>
  `${String(ms).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${replica}`;

function chain(): [FederatedOp, FederatedOp, FederatedOp, FederatedOp] {
  const key = buildOp(
    {
      replica: R,
      seq: 4,
      prev: ZERO_HASH,
      hlc: hlc(1000),
      type: 'key',
      body: {
        handle: 'ada',
        device: 'laptop',
        build: '0.40.0',
        signPub: keys.signPub,
        sealPub: keys.sealPub,
        legacy: { throughSeq: 3, digest: 'd'.repeat(64) },
      },
    },
    keys.signPriv
  );
  const task = buildOp(
    {
      replica: R,
      seq: 6,
      prev: opHash(key),
      hlc: hlc(1000, 1),
      type: 'task',
      body: { task: 't-00000a01', kind: 'put', fields: { title: 'x' } },
    },
    keys.signPriv
  );
  const { to, sealed } = sealPayload({
    replica: R,
    seq: 7,
    type: 'mail',
    payload: { m: 1 },
    recipients: new Map([['bob-0000000b', peer.sealPub]]),
  });
  const mail = buildOp(
    {
      replica: R,
      seq: 7,
      prev: opHash(task),
      hlc: hlc(1001),
      type: 'mail',
      to,
      sealed,
    },
    keys.signPriv
  );
  const presence = buildOp(
    {
      replica: R,
      seq: 8,
      prev: opHash(mail),
      hlc: hlc(1002),
      type: 'presence',
      body: { kind: 'replica', build: '0.40.0', device: 'laptop', wall: 1002 },
    },
    keys.signPriv
  );
  return [key, task, mail, presence];
}

function run(entries: LogEntry[]): {
  head: ChainHead | null;
  failure: string | null;
} {
  let head: ChainHead | null = null;
  for (const e of entries) {
    const r = verifyEntry(head, e, keys.signPub);
    if (!r.ok) return { head, failure: r.reason };
    head = r.head;
  }
  return { head, failure: null };
}

describe('verifyEntry along a chain', () => {
  it('accepts a chain that starts at its key op, with seq gaps and a mail stub', () => {
    const [key, task, mail, presence] = chain();
    expect(run([key, task, mail, presence]).failure).toBeNull();
    expect(run([key, task, stubOf(mail), presence]).failure).toBeNull();
    expect(opHash(stubOf(mail))).toBe(opHash(mail));
  });

  it('refuses each way a log can be forged or broken', () => {
    const [key, task, mail, presence] = chain();
    const next = (seq: number, at: string, type = 'task') =>
      buildOp(
        { replica: R, seq, prev: opHash(key), hlc: at, type, body: {} },
        keys.signPriv
      );
    const cases: [string, LogEntry[]][] = [
      ['a log must start with its key op', [task]],
      ['prev does not match', [key, mail]],
      ['a task op cannot be a stub', [key, stubOf(task)]],
      ['bad signature', [key, task, { ...stubOf(mail), to: ['eve-0000000e'] }]],
      [
        'bodyHash mismatch',
        [
          key,
          {
            ...task,
            body: { task: 't-00000a01', kind: 'put', fields: { title: 'y' } },
          },
        ],
      ],
      ['hlc must rise', [key, next(6, hlc(999))]],
      [
        'hlc must name its own replica',
        [key, next(6, hlc(2000, 0, 'bob-0000000b'))],
      ],
      ['seq must rise', [key, next(4, hlc(2000))]],
      ['a second key op', [key, next(5, hlc(2000), 'key')]],
      ['replica id outside the grammar', [{ ...key, replica: 'ada' }]],
      [
        'sealed types carry sealed content',
        [
          key,
          task,
          buildOp(
            {
              replica: R,
              seq: 7,
              prev: opHash(task),
              hlc: hlc(1001),
              type: 'mail',
              body: { m: 1 },
            },
            keys.signPriv
          ),
        ],
      ],
    ];
    for (const [reason, entries] of cases)
      expect(run(entries).failure).toBe(reason);
    expect(presence).toBeDefined();
  });

  it('refuses sealed content whose wraps do not name exactly its recipients', () => {
    const [key, task, mail] = chain();
    const sealed = mail.sealed;
    if (sealed === undefined) throw new Error('unsealed');
    const resealed = (to: string[] | undefined, wraps = sealed.keys) => {
      const fields = {
        replica: R,
        seq: 7,
        prev: opHash(task),
        hlc: hlc(1001),
        type: 'mail',
        sealed: { ...sealed, keys: wraps },
      };
      return buildOp(
        to === undefined ? fields : { ...fields, to },
        keys.signPriv
      );
    };
    for (const forged of [
      resealed(undefined),
      resealed(undefined, {}),
      resealed(['cy-0000000c']),
    ])
      expect(run([key, task, forged]).failure).toBe('keys must equal to');
    expect(run([key, task, resealed(mail.to)]).failure).toBeNull();
  });

  it('refuses a signature re-encoded by someone without the key', () => {
    const [key, task] = chain();
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(task.sig.charAt(task.sig.length - 1));
    // An 86-character signature leaves four bits of its last character unused.
    const reencoded = {
      ...task,
      sig: `${task.sig.slice(0, -1)}${alphabet.charAt(last ^ 1)}`,
    };
    expect(Buffer.from(reencoded.sig, 'base64url')).toEqual(
      Buffer.from(task.sig, 'base64url')
    );
    expect(opHash(reencoded)).not.toBe(opHash(task));
    expect(run([key, reencoded]).failure).toBe('bad signature');
  });

  it('refuses hostile entries parsed off a branch instead of throwing', () => {
    const [key, task, mail] = chain();
    // JSON.parse turns 1e400 into Infinity, which JCS cannot serialize.
    const parsed = (e: LogEntry, from: RegExp, to: string) =>
      JSON.parse(JSON.stringify(e).replace(from, to)) as LogEntry;
    const bodyHash = /"bodyHash":"[0-9a-f]{64}"/;
    const cases: LogEntry[][] = [
      [key, parsed(task, bodyHash, '"bodyHash":1e400')],
      [key, task, parsed(stubOf(mail), bodyHash, '"bodyHash":1e400')],
      [key, parsed(task, /"prev":"[0-9a-f]{64}"/, '"prev":1e400')],
      [key, parsed(task, /"sig":"[^"]+"/, '"sig":1e400')],
      // Signed by its own key, with content no JCS can hash.
      [parsed(key, /"build":"[^"]+"/, '"build":1e400')],
      [key, JSON.parse('null') as LogEntry],
      [key, JSON.parse('"op"') as LogEntry],
      [key, JSON.parse('[]') as LogEntry],
    ];
    for (const entries of cases)
      expect(run(entries).failure).toBe('malformed op');
  });

  it('pins the fingerprint over both public keys', () => {
    expect(fingerprint(keys.signPub, keys.sealPub)).not.toBe(
      fingerprint(keys.signPub, peer.sealPub)
    );
  });
});
