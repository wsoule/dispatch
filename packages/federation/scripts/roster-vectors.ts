import { ed25519FromSeed, sha256Hex } from '@dispatch/protocol/federation';
import type { RosterBody } from '@dispatch/protocol/federation';
import { writeFileSync } from 'node:fs';

import { foldRoster } from '../src/roster.js';
import type {
  FoldInput,
  KeyInfo,
  RosterOpRef,
  RosterView,
} from '../src/roster.js';

// Roster fold scenarios that need no signature: the property test folds each in
// every order, and running this file writes each to vectors/roster for the relay.

export const ROSTER_VECTORS_DIR = new URL(
  '../vectors/roster/',
  import.meta.url
);

export interface RosterScenario {
  name: string;
  input: FoldInput;
}

/** A scenario as JSON: `keys` as entries, `now` as an ISO string. */
export interface RosterVector {
  name: string;
  input: {
    founder: FoldInput['founder'];
    ops: RosterOpRef[];
    keys: [string, KeyInfo][];
    now: string;
    licensePublicKey: string | null;
  };
  expect: unknown;
}

const A = 'ada-0000000a';
const B = 'bob-0000000b';
const C = 'cy-0000000c';
const D = 'dee-0000000d';
const B2 = 'bob-0000000f';
const A2 = 'ada-0000000e';
const OBS = 'obs-00000010';
const handleOf = (r: string) => r.slice(0, r.lastIndexOf('-'));
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const RECOVERY_PUB = ed25519FromSeed(Buffer.alloc(32, 7)).signPub;

const keys = new Map<string, KeyInfo>(
  [A, B, C, D, B2, A2, OBS].map((r) => [
    r,
    {
      replica: r,
      handle: handleOf(r),
      signPub: `sign-${r}`,
      fingerprint: `FP-${r}`,
    },
  ])
);

function op(
  replica: string,
  seq: number,
  ms: number,
  body: Record<string, unknown>
): RosterOpRef {
  return {
    replica,
    seq,
    hlc: `${String(T0 + ms).padStart(13, '0')}.0000.${replica}`,
    hash: sha256Hex(`${replica}:${seq}:${JSON.stringify(body)}`),
    body: { rv: 1, ...body } as RosterBody,
  };
}

const FOUND = op(A, 1, 0, {
  action: 'found',
  name: 'acme',
  legacy: [],
  recoveryPub: RECOVERY_PUB,
});

const admit = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  role = 'member',
  extra: Record<string, unknown> = {}
) =>
  op(by, seq, ms, {
    action: 'admit',
    replica: target,
    handle: handleOf(target),
    role,
    fingerprint: `FP-${target}`,
    ...extra,
  });

const revoke = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  afterSeq: number
) =>
  op(by, seq, ms, {
    action: 'revoke',
    replica: target,
    afterSeq,
    afterHash: `h-${target}-${afterSeq}`,
    reason: 'test',
  });

const ATTEST = [
  { replica: 'old-00000099', throughSeq: 4, digest: 'd'.repeat(64) },
];

function scenario(
  name: string,
  ops: RosterOpRef[],
  nowMs = DAY,
  found = FOUND
): RosterScenario {
  return {
    name,
    input: {
      founder: { replica: A, seq: 1 },
      ops: [found, ...ops],
      keys,
      now: new Date(T0 + nowMs),
      licensePublicKey: null,
    },
  };
}

// B and D fight. A2 has the right to its removal only if D wins: that cuts B's
// admit of B2, so A's admin admit of B2 stands and B2's promotion of A2 counts.
function fightGrantsRight(first: string, second: string): RosterOpRef[] {
  return [
    admit(A, 2, 100, C, 'admin'),
    admit(A, 3, 101, first, 'admin'),
    admit(A, 4, 102, second, 'admin'),
    admit(A, 5, 103, OBS, 'admin'),
    admit(A, 6, 104, A2),
    op(C, 2, 200, { action: 'role', replica: A2, role: 'admin' }),
    admit(B, 2, 210, B2),
    admit(A, 7, 220, B2, 'admin'),
    op(B2, 2, 230, { action: 'role', replica: A2, role: 'admin' }),
    revoke(A, 8, 300, C, 1),
    revoke(D, 2, 310, B, 1),
    revoke(B, 3, 320, D, 1),
    revoke(A2, 2, 330, OBS, 1),
  ];
}

export const SCENARIOS: readonly RosterScenario[] = [
  scenario('founding', []),
  scenario('fingerprint-mismatch', [
    admit(A, 2, 100, B),
    op(A, 3, 200, {
      action: 'admit',
      replica: C,
      handle: 'cy',
      role: 'member',
      fingerprint: 'FP-wrong',
    }),
  ]),
  scenario('member-devices', [
    admit(A, 2, 100, B),
    admit(B, 2, 200, B2),
    admit(B, 3, 300, C),
    admit(B, 4, 400, 'bob-00000011', 'admin'),
  ]),
  scenario('seq-cut', [
    admit(A, 2, 100, B, 'admin'),
    admit(B, 4, 120, D),
    admit(B, 7, 150, C),
    revoke(A, 3, 300, B, 5),
  ]),
  scenario('revocation-fight', [
    admit(A, 2, 100, B, 'admin'),
    admit(A, 3, 150, C, 'admin'),
    revoke(B, 3, 200, C, 1),
    revoke(C, 3, 190, B, 1),
  ]),
  scenario('backdated-counter-revocation', [
    admit(A, 2, 100, B, 'admin'),
    revoke(A, 3, 300, B, 2),
    revoke(B, 3, 50, A, 2),
  ]),
  scenario('three-admin-cycle', [
    admit(A, 2, 100, B, 'admin'),
    admit(A, 3, 110, C, 'admin'),
    revoke(A, 4, 300, B, 1),
    revoke(B, 2, 300, C, 1),
    revoke(C, 2, 300, A, 3),
  ]),
  scenario('grantor-cut', [
    admit(A, 2, 100, B, 'admin'),
    admit(B, 2, 150, C, 'admin'),
    admit(A, 3, 160, D),
    revoke(C, 2, 200, D, 1),
    revoke(A, 4, 300, B, 1),
  ]),
  scenario('last-admin', [
    op(A, 2, 100, {
      action: 'role',
      replica: A,
      role: 'member',
      afterSeq: 1,
      afterHash: FOUND.hash,
    }),
  ]),
  scenario('late-right', [
    admit(A, 2, 100, C, 'admin'),
    admit(A, 3, 110, B, 'admin'),
    admit(A, 4, 120, D),
    admit(B, 2, 200, A2),
    admit(A, 5, 300, A2, 'admin'),
    revoke(A2, 2, 400, D, 1),
    revoke(C, 2, 500, B, 1),
    revoke(B, 3, 500, C, 1),
  ]),
  scenario('waiting-cutter', [
    admit(A, 2, 100, C, 'admin'),
    admit(A, 3, 110, B, 'admin'),
    admit(A, 4, 120, D),
    admit(C, 2, 200, A2),
    admit(A, 5, 300, A2, 'admin'),
    revoke(A, 6, 400, C, 1),
    revoke(B, 2, 500, D, 1),
    revoke(A2, 2, 600, B, 1),
  ]),
  scenario('fight-grants-right', fightGrantsRight(B, D)),
  scenario('fight-grants-right-reversed', fightGrantsRight(D, B)),
  scenario('hopeless-removal', [
    admit(A, 2, 100, B, 'admin'),
    admit(A, 3, 110, C, 'admin'),
    admit(A, 4, 120, D),
    admit(A, 5, 130, A2),
    revoke(C, 2, 200, B, 2),
    revoke(B, 3, 300, D, 1),
    revoke(A2, 2, 250, C, 1),
  ]),
  scenario('demotion-then-promotion', [
    admit(A, 2, 100, B, 'admin'),
    admit(B, 2, 150, C),
    admit(B, 3, 200, OBS, 'member', { observer: true }),
    op(A, 3, 300, {
      action: 'role',
      replica: B,
      role: 'member',
      afterSeq: 2,
      afterHash: 'h',
    }),
    op(A, 4, 400, { action: 'role', replica: B, role: 'admin' }),
    admit(B, 4, 500, D),
  ]),
  scenario('observer-admin', [
    admit(A, 2, 100, OBS, 'admin', { observer: true }),
    admit(A, 3, 150, C, 'member', { observer: true }),
    op(A, 4, 200, { action: 'role', replica: C, role: 'admin' }),
    op(A, 5, 300, {
      action: 'role',
      replica: A,
      role: 'member',
      afterSeq: 4,
      afterHash: 'h',
    }),
  ]),
  scenario('transport-and-invites', [
    admit(A, 2, 100, B),
    op(A, 3, 200, {
      action: 'transport',
      kind: 'relay',
      url: 'https://relay.test',
    }),
    op(B, 2, 300, { action: 'transport', kind: 'git' }),
    op(B, 3, 400, {
      action: 'invite',
      id: 'i-own',
      pub: 'P',
      handle: 'bob',
      expires: '2026-10-03T00:00:00.000Z',
    }),
    op(B, 4, 500, {
      action: 'invite',
      id: 'i-other',
      pub: 'P',
      handle: 'cy',
      expires: '2026-10-03T00:00:00.000Z',
    }),
  ]),
  scenario('seats-hosts-observer', [
    admit(A, 2, 100, B, 'member', { hosts: ['eve'] }),
    admit(A, 3, 200, OBS, 'member', { observer: true }),
    admit(A, 4, 300, C),
    admit(A, 5, 400, D),
  ]),
  scenario('hosts-removal', [
    admit(A, 2, 100, B, 'member', { hosts: ['eve'] }),
    op(A, 3, 200, {
      action: 'hosts',
      replica: B,
      hosts: [],
      afterSeq: 6,
      afterHash: 'h',
    }),
  ]),
  scenario('observer-roster-op', [
    admit(A, 2, 100, OBS, 'member', { observer: true }),
    op(OBS, 2, 200, {
      action: 'invite',
      id: 'i-obs',
      pub: 'P',
      handle: 'obs',
      expires: '2026-10-03T00:00:00.000Z',
    }),
  ]),
  scenario('stolen-device', [
    admit(A, 2, 100, B),
    admit(B, 2, 200, B2),
    revoke(B, 3, 500, B2, 1),
    revoke(B2, 2, 250, B, 2),
  ]),
  scenario('unknown-action', [op(A, 2, 100, { action: 'teleport' })]),
  scenario('unknown-rv', [admit(A, 2, 100, B, 'member', { rv: 2 })]),
  scenario('unknown-at-recover', [
    op(C, 2, 100, { action: 'recover', proof: 'p', rv: 2 }),
    op(D, 2, 100, { action: 'recover', proof: 'p' }),
    op(D, 3, 150, { action: 'teleport' }),
  ]),
  scenario('unknown-above-cut', [
    admit(A, 2, 100, B, 'admin'),
    revoke(A, 3, 300, B, 5),
    admit(B, 6, 400, C, 'member', { rv: 2 }),
    op(B, 7, 150, { action: 'teleport' }),
  ]),
  scenario(
    'legacy-close-early',
    [
      admit(A, 2, 100, B),
      op(B, 2, 10 * DAY, { action: 'close-legacy', entries: ATTEST }),
    ],
    40 * DAY
  ),
  scenario(
    'legacy-close-late',
    [
      admit(A, 2, 100, B),
      op(B, 2, 31 * DAY, { action: 'close-legacy', entries: ATTEST }),
    ],
    40 * DAY
  ),
  scenario(
    'legacy-people',
    [admit(A, 2, 100, B), admit(A, 3, 200, C)],
    DAY,
    op(A, 1, 0, {
      action: 'found',
      name: 'acme',
      legacy: [
        ...ATTEST,
        { replica: C, throughSeq: 2, digest: 'e'.repeat(64) },
      ],
      recoveryPub: RECOVERY_PUB,
    })
  ),
  scenario('legacy-close-admin', [
    op(A, 2, DAY, { action: 'close-legacy', entries: [] }),
    admit(A, 3, 2 * DAY, B),
    op(B, 2, 31 * DAY, { action: 'close-legacy', entries: ATTEST }),
  ]),
];

const byKey = <T>(m: ReadonlyMap<string, T>): [string, T][] =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

/** The parts of a view the golden vectors pin, in a form that ignores map order. */
export function normalize(v: RosterView): unknown {
  return {
    members: [...v.members.values()]
      .sort((a, b) => (a.replica < b.replica ? -1 : 1))
      .map((m) => [
        m.replica,
        m.role,
        m.rank,
        [...m.hosts].sort(),
        m.observer,
        m.recovered,
      ]),
    revoked: byKey(v.revoked),
    hostCuts: byKey(v.hostCuts),
    resolution: byKey(v.resolution),
    pending: v.pending,
    invites: byKey(v.invites),
    invitedBy: byKey(v.invitedBy),
    seats: v.seats,
    people: v.people,
    covered: [...v.covered].sort(),
    closedBy: v.legacy.closed?.by ?? null,
    transport: v.transport,
    unknown: v.unknown,
  };
}

export function fromVector(input: RosterVector['input']): FoldInput {
  return { ...input, keys: new Map(input.keys), now: new Date(input.now) };
}

export function makeRosterVectors(): RosterVector[] {
  return SCENARIOS.map(({ name, input }) => ({
    name,
    input: {
      founder: input.founder,
      ops: [...input.ops],
      keys: [...input.keys.entries()],
      now: input.now.toISOString(),
      licensePublicKey: input.licensePublicKey,
    },
    expect: normalize(foldRoster(input)),
  }));
}

if (import.meta.main) {
  for (const v of makeRosterVectors()) {
    writeFileSync(
      new URL(`${v.name}.json`, ROSTER_VECTORS_DIR),
      `${JSON.stringify(v, null, 2)}\n`
    );
  }
}
