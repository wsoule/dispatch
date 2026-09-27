import { describe, expect, it } from 'bun:test';

import type { JsonValue } from '../../src/envelope.js';
import { buildOp, verifyEntry } from '../../src/federation/chain.js';
import type { ChainHead } from '../../src/federation/chain.js';
import { fingerprint } from '../../src/federation/fingerprint.js';
import { MAX_HLC_COUNTER, OpClock } from '../../src/federation/hlc.js';
import { CanonicalizeError } from '../../src/federation/jcs.js';
import { generateReplicaKeys, signText } from '../../src/federation/keys.js';
import {
  contentHash,
  MAX_OP_BYTES,
  opHash,
  signingInput,
  stubOf,
  ZERO_HASH,
} from '../../src/federation/ops.js';
import type {
  FederatedOp,
  LogEntry,
  OpHeader,
  Sealed,
} from '../../src/federation/ops.js';
import { sealPayload } from '../../src/federation/seal.js';

const R = 'ada-0000000a';
const keys = generateReplicaKeys();
const peer = generateReplicaKeys();
const hlc = (ms: number, counter = 0, replica = R) =>
  `${String(ms).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${replica}`;

type OpFields = Parameters<typeof buildOp>[0];

// Signs any header, as a buggy or hostile publisher could; buildOp refuses to.
function forge(fields: OpFields): FederatedOp {
  const content: { body?: JsonValue; sealed?: Sealed } = {};
  if (fields.body !== undefined) content.body = fields.body;
  if (fields.sealed !== undefined) content.sealed = fields.sealed;
  const { replica, seq, prev, hlc: at, type } = fields;
  const header: OpHeader = {
    v: 2,
    replica,
    seq,
    prev,
    hlc: at,
    type,
    bodyHash: contentHash(content),
  };
  if (fields.to !== undefined) header.to = fields.to;
  return {
    ...header,
    ...content,
    sig: signText(keys.signPriv, signingInput(header)),
  };
}

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
      forge({ replica: R, seq, prev: opHash(key), hlc: at, type, body: {} });
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
          forge({
            replica: R,
            seq: 7,
            prev: opHash(task),
            hlc: hlc(1001),
            type: 'mail',
            body: { m: 1 },
          }),
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
      return forge(to === undefined ? fields : { ...fields, to });
    };
    for (const forged of [
      resealed(undefined),
      resealed(undefined, {}),
      resealed(['cy-0000000c']),
    ])
      expect(run([key, task, forged]).failure).toBe('keys must equal to');
    expect(run([key, task, resealed(mail.to)]).failure).toBeNull();
  });

  it('refuses signed ops that break the grammar, sealing or size rules', () => {
    const [key, task, mail] = chain();
    const { to, sealed } = mail;
    if (to === undefined || sealed === undefined) throw new Error('unsealed');
    const signed = (fields: {
      type: string;
      body?: JsonValue;
      to?: string[];
      sealed?: Sealed;
    }) =>
      forge({
        replica: R,
        seq: 7,
        prev: opHash(task),
        hlc: hlc(1001),
        ...fields,
      });
    const cases: [string, LogEntry][] = [
      [
        'bad recipient list',
        signed({ type: 'mail', to: [...to, ...to], sealed }),
      ],
      ['bad recipient list', signed({ type: 'mail', to: [], sealed })],
      [
        'only mail and state are sealed',
        signed({ type: 'task', body: {}, to }),
      ],
      [
        'only mail and state are sealed',
        signed({ type: 'task', body: {}, sealed }),
      ],
      [
        'state ops carry only sealed content',
        signed({ type: 'state', body: {}, to, sealed }),
      ],
      [
        'over MAX_OP_BYTES',
        signed({ type: 'task', body: { text: 'x'.repeat(MAX_OP_BYTES) } }),
      ],
      // headerOf always signs v: 2, so only the grammar check refuses v: 1.
      [
        'not a v2 op',
        { ...signed({ type: 'task', body: {} }), v: 1 } as unknown as LogEntry,
      ],
      ['not a v2 op', signed({ type: 'Task', body: {} })],
    ];
    for (const [reason, e] of cases)
      expect(run([key, task, e]).failure).toBe(reason);
  });

  it('accepts a forward and stubs of presence and state ops', () => {
    const [key, task, mail, presence] = chain();
    const sealedTo = (
      seq: number,
      type: 'mail' | 'state',
      payload: JsonValue
    ) =>
      sealPayload({
        replica: R,
        seq,
        type,
        payload,
        recipients: new Map([['cy-0000000c', peer.sealPub]]),
      });
    const s = sealedTo(9, 'state', { entries: [] });
    const state = buildOp(
      {
        replica: R,
        seq: 9,
        prev: opHash(presence),
        hlc: hlc(1003),
        type: 'state',
        to: s.to,
        sealed: s.sealed,
      },
      keys.signPriv
    );
    const f = sealedTo(10, 'mail', { target: 'task:t-00000a01', key: 'k' });
    // A forward: a mail op with a clear body and sealed content.
    const forward = buildOp(
      {
        replica: R,
        seq: 10,
        prev: opHash(state),
        hlc: hlc(1004),
        type: 'mail',
        body: { forward: JSON.parse(JSON.stringify(mail)) as JsonValue },
        to: f.to,
        sealed: f.sealed,
      },
      keys.signPriv
    );
    expect(run([key, task, mail, presence, state, forward]).failure).toBeNull();
    expect(
      run([key, task, mail, stubOf(presence), stubOf(state), forward]).failure
    ).toBeNull();
  });

  it('refuses a signature re-encoded by someone without the key', () => {
    const [key, task] = chain();
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(task.sig.charAt(task.sig.length - 1));
    // An 86-character signature leaves four bits of its last character unused.
    const respelled = {
      ...task,
      sig: `${task.sig.slice(0, -1)}${alphabet.charAt(last ^ 1)}`,
    };
    expect(Buffer.from(respelled.sig, 'base64url')).toEqual(
      Buffer.from(task.sig, 'base64url')
    );
    expect(opHash(respelled)).not.toBe(opHash(task));
    expect(run([key, respelled]).failure).toBe('bad signature');
  });

  it('refuses hostile entries parsed off a branch instead of throwing', () => {
    const [key, task, mail] = chain();
    // JSON.parse turns 1e400 into Infinity, which JCS cannot serialize.
    const parsed = (e: LogEntry, from: RegExp, to: string) =>
      JSON.parse(JSON.stringify(e).replace(from, to)) as LogEntry;
    const bodyHash = /"bodyHash":"[0-9a-f]{64}"/;
    // Too deep for JSON.stringify's recursion, yet far under MAX_OP_BYTES.
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const cases: LogEntry[][] = [
      [key, parsed(task, /"fields":\{[^}]*\}/, `"fields":${deep}`)],
      [key, task, parsed(stubOf(mail), /^\{/, `{"junk":${deep},`)],
      [key, parsed(task, bodyHash, '"bodyHash":1e400')],
      [key, task, parsed(stubOf(mail), bodyHash, '"bodyHash":1e400')],
      [key, parsed(task, /"prev":"[0-9a-f]{64}"/, '"prev":1e400')],
      [key, parsed(task, /"sig":"[^"]+"/, '"sig":1e400')],
      // Signed by its own key, with content no JCS can hash.
      [parsed(key, /"build":"[^"]+"/, '"build":1e400')],
      [parsed(key, /"build":"[^"]+"/, '"build":"\\ud800"')],
      [key, JSON.parse('null') as LogEntry],
      [key, JSON.parse('"op"') as LogEntry],
      [key, JSON.parse('[]') as LogEntry],
    ];
    for (const entries of cases)
      expect(run(entries).failure).toBe('malformed op');
  });

  it('refuses a counter past MAX_HLC_COUNTER, and orders counters up to it exactly', () => {
    const [key, task] = chain();
    const at = (counter: string) => `0000000001001.${counter}.${R}`;
    const after = (prev: FederatedOp, seq: number, clock: string) =>
      forge({
        replica: R,
        seq,
        prev: opHash(prev),
        hlc: clock,
        type: 'task',
        body: {},
      });
    for (const over of [
      String(MAX_HLC_COUNTER + 1),
      '9007199254740993',
      '1000000000000000000000',
    ])
      expect(run([key, task, after(task, 7, at(over))]).failure).toBe(
        'hlc outside the grammar'
      );
    const below = after(task, 7, at(String(MAX_HLC_COUNTER - 1)));
    const top = after(below, 8, at(String(MAX_HLC_COUNTER)));
    expect(run([key, task, below, top]).failure).toBeNull();
    const again = after(below, 8, at(String(MAX_HLC_COUNTER - 1)));
    expect(run([key, task, below, again]).failure).toBe('hlc must rise');
  });

  // A peer 4 minutes ahead passes the clock guard, so its reading is adopted.
  it("signs the next op after adopting a peer's counter at the bound", () => {
    const [key, task] = chain();
    const clock = new OpClock(R, task.hlc, () => 1000);
    clock.observe(`0000000241000.${String(MAX_HLC_COUNTER)}.bob-0000000b`);
    const next = buildOp(
      {
        replica: R,
        seq: 7,
        prev: opHash(task),
        hlc: clock.tick(),
        type: 'task',
        body: {},
      },
      keys.signPriv
    );
    expect(next.hlc).toBe(hlc(241_001));
    expect(run([key, task, next]).failure).toBeNull();
  });

  // Its content is never hashed, so it could say anything under the op's hash.
  it('refuses a stub that carries a body or sealed content', () => {
    const [key, task, mail, presence] = chain();
    const runBody = { kind: 'run', live: true, waitingOn: 'bob' };
    const cases = [
      [key, task, mail, { ...stubOf(presence), body: runBody }],
      [key, task, mail, { ...stubOf(presence), body: null }],
      [key, task, { ...stubOf(mail), sealed: mail.sealed }],
    ] as LogEntry[][];
    for (const entries of cases)
      expect(run(entries).failure).toBe('a stub carries no content');
  });

  // Every peer would refuse such an op, halting this replica's log for good.
  it('buildOp refuses to sign a header outside the grammar', () => {
    const [key] = chain();
    const base: OpFields = {
      replica: R,
      seq: 5,
      prev: opHash(key),
      hlc: hlc(2000),
      type: 'task',
      body: {},
    };
    const cases: [string, Partial<OpFields>][] = [
      [
        'replica id outside the grammar',
        { replica: 'ada', hlc: hlc(2000, 0, 'ada') },
      ],
      ['not a v2 op', { type: 'Task' }],
      ['seq must rise', { seq: 0 }],
      ['malformed op', { prev: 'x' }],
      [
        'hlc outside the grammar',
        { hlc: `0000000002000.${String(MAX_HLC_COUNTER + 1)}.${R}` },
      ],
      ['hlc must name its own replica', { hlc: hlc(2000, 0, 'bob-0000000b') }],
      [
        'bad recipient list',
        { type: 'mail', to: ['cy-0000000c', 'bob-0000000b'] },
      ],
      ['bad recipient list', { type: 'mail', to: ['bob'] }],
      ['bad recipient list', { type: 'mail', to: [] }],
    ];
    for (const [reason, change] of cases)
      expect(() => buildOp({ ...base, ...change }, keys.signPriv)).toThrow(
        `cannot sign: ${reason}`
      );
    expect(run([key, buildOp(base, keys.signPriv)]).failure).toBeNull();
  });

  it('buildOp refuses to sign content every peer would refuse', () => {
    const [key, task, mail] = chain();
    const { to, sealed } = mail;
    if (to === undefined || sealed === undefined) throw new Error('unsealed');
    const base: OpFields = {
      replica: R,
      seq: 7,
      prev: opHash(task),
      hlc: hlc(1001),
      type: 'mail',
    };
    const cases: [string, Partial<OpFields>][] = [
      ['sealed types carry sealed content', { body: { m: 1 } }],
      ['sealed types carry sealed content', { type: 'state', to }],
      [
        'state ops carry only sealed content',
        { type: 'state', body: {}, to, sealed },
      ],
      ['only mail and state are sealed', { type: 'task', body: {}, to }],
      ['only mail and state are sealed', { type: 'task', body: {}, sealed }],
      ['keys must equal to', { sealed }],
      ['keys must equal to', { to: ['cy-0000000c'], sealed }],
    ];
    for (const [reason, change] of cases) {
      const fields = { ...base, ...change };
      expect(() => buildOp(fields, keys.signPriv)).toThrow(
        `cannot sign: ${reason}`
      );
      expect(run([key, task, forge(fields)]).failure).toBe(reason);
    }
    const signed = buildOp({ ...base, to, sealed }, keys.signPriv);
    expect(run([key, task, signed]).failure).toBeNull();
  });

  it('buildOp throws a CanonicalizeError for content JCS cannot write', () => {
    const [key] = chain();
    const signing = (body: JsonValue) => () =>
      buildOp(
        {
          replica: R,
          seq: 5,
          prev: opHash(key),
          hlc: hlc(2000),
          type: 'task',
          body,
        },
        keys.signPriv
      );
    let deep: JsonValue = [];
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const bodies: JsonValue[] = [
      { title: 'a\ud800' },
      { n: Number.NaN },
      { fields: deep },
    ];
    for (const body of bodies) expect(signing(body)).toThrow(CanonicalizeError);
  });

  it('pins the fingerprint over both public keys', () => {
    expect(fingerprint(keys.signPub, keys.sealPub)).not.toBe(
      fingerprint(keys.signPub, peer.sealPub)
    );
  });
});
