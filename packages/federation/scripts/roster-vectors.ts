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

// The roster fold scenarios that need no signature. The property test folds
// each in every order; run as a script (`bun
// packages/federation/scripts/roster-vectors.ts`, then `moon run root:format`)
// it writes each to vectors/roster, the files the relay's CI also folds.

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
const OBS = 'obs-00000010';
const handleOf = (r: string) => r.slice(0, r.lastIndexOf('-'));
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const RECOVERY_PUB = ed25519FromSeed(Buffer.alloc(32, 7)).signPub;

const keys = new Map<string, KeyInfo>(
  [A, B, C, D, B2, OBS].map((r) => [
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
    revoked: [...v.revoked.keys()].sort(),
    seats: v.seats,
    covered: [...v.covered].sort(),
    closedBy: v.legacy.closed?.by ?? null,
    transport: v.transport,
    unknown: v.unknown === null,
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
