import type { RosterView } from '@dispatch/federation';
import { describe, expect, it } from 'bun:test';

import {
  assembleTeamKeys,
  BRANCH_SIZE_WARN_BYTES,
  PRUNE_BLOCKED_AFTER_MS,
} from '../../../src/team/federation/teamKeys.js';

const NOW = new Date('2026-10-26T00:00:00.000Z');
const member = (replica: string, handle: string, observer = false) => ({
  replica,
  handle,
  role: replica.startsWith('ada') ? 'admin' : 'member',
  hosts: [],
  observer,
  rank: replica.startsWith('ada') ? 0 : null,
  recovered: false,
  since: { hlc: '1758880000000.0000.ada-0000000a', replica, seq: 1 },
});
const view = {
  teamId: 'a'.repeat(32),
  name: 'acme',
  founder: 'ada-0000000a',
  members: new Map([
    ['ada-0000000a', member('ada-0000000a', 'ada')],
    ['bob-0000000b', member('bob-0000000b', 'bob')],
    ['ops-0000000c', member('ops-0000000c', 'ops', true)],
  ]),
  revoked: new Map(),
  hostCuts: new Map(),
  pending: [],
  invites: new Map(),
  invitedBy: new Map(),
  recoveryPub: 'R',
  license: { kind: 'free', seats: 3 },
  licenseBy: null,
  seats: 3,
  people: ['ada', 'bob'],
  covered: new Set(['ada', 'bob']),
  legacy: {
    deadlineMs: Date.parse('2026-10-26T00:00:00.000Z'),
    attested: [],
    closed: null,
  },
  transport: { kind: 'git' },
  problems: [],
  unknown: null,
} as unknown as RosterView;
const pin = (replica: string, handle: string) => ({
  replica,
  handle,
  device: 'laptop',
  build: '0.40.0',
  signPub: 'S',
  sealPub: 'X',
  fingerprint: `FP-${handle}`,
  keySeq: 1,
  legacy: null,
});
const health = (
  over: Partial<Parameters<typeof assembleTeamKeys>[0]['health']> = {}
) => ({
  kind: 'git' as const,
  lastExchangeAt: null,
  lastError: null,
  unpublished: 0,
  sizeBytes: 1024,
  readBytes: 0,
  acks: {},
  ...over,
});
function keys(over: Partial<Parameters<typeof assembleTeamKeys>[0]> = {}) {
  return assembleTeamKeys({
    machine: {
      replica: 'ada-0000000a',
      handle: 'ada',
      device: 'laptop',
      fingerprint: 'FP-ada',
    },
    view,
    foundings: [],
    pins: [
      pin('ada-0000000a', 'ada'),
      pin('bob-0000000b', 'bob'),
      pin('ops-0000000c', 'ops'),
    ],
    replicas: [],
    health: health(),
    problems: [],
    remote: null,
    now: NOW,
    ...over,
  });
}

describe('assembleTeamKeys', () => {
  it('names the roster op a pause waits on, for a dismiss (FW-R8/R9)', () => {
    expect(keys().pause).toBeNull();
    const paused = keys({
      view: {
        ...view,
        unknown: {
          replica: 'bob-0000000b',
          seq: 4,
          hlc: '1790000000000.0000.bob-0000000b',
          hash: 'h'.repeat(64),
        },
      } as never,
    });
    expect(paused.pause).toEqual({
      replica: 'bob-0000000b',
      seq: 4,
      hash: 'h'.repeat(64),
    });
  });

  it('never shows the credentials in a remote or a transport error (G)', () => {
    const k = keys({
      remote: 'https://ada:ghp_secret@example.com/team/board.git',
      health: health({
        lastError: "unable to access 'https://ada:ghp_secret@example.com/x/'",
      }),
    });
    expect(JSON.stringify(k)).not.toContain('ghp_secret');
    expect(k.originWarning).toContain('https://example.com/team/board.git');
  });

  it('warns above 1 GiB of branch and recommends the relay or a fresh sync.repo', () => {
    expect(keys().warnings.some((w) => w.includes('GiB'))).toBe(false);
    const big = keys({
      health: health({ sizeBytes: BRANCH_SIZE_WARN_BYTES + 1 }),
    });
    expect(big.warnings).toContain(
      'The sync branch is over 1 GiB. Switch to the relay, or start a fresh sync.repo.'
    );
  });

  it('lists an admitted replica silent past 30 days as blocking pruning', () => {
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    const stale = new Date(
      NOW.getTime() - PRUNE_BLOCKED_AFTER_MS - 60_000
    ).toISOString();
    const k = keys({
      health: health({
        acks: {
          'ada-0000000a': fresh,
          'bob-0000000b': stale,
          'ops-0000000c': fresh,
        },
      }),
    });
    expect(k.pruningBlockers).toEqual([
      { replica: 'bob-0000000b', handle: 'bob', lastAck: stale },
    ]);
  });

  it('warns while an observer is admitted, and with fewer than two admins', () => {
    const k = keys();
    expect(k.warnings).toContain(
      'ops (laptop) is an observer: it reads team messages that leave a machine.'
    );
    expect(
      k.warnings.some((w) =>
        w.startsWith('Only ada can admit, revoke or change the team.')
      )
    ).toBe(true);
  });

  it('carries the origin warning with the remote filled in only when sync.repo is unset', () => {
    expect(keys().originWarning).toBeNull();
    expect(
      keys({ remote: 'git@github.com:acme/app.git' }).originWarning
    ).toStartWith(
      'Everyone with access to git@github.com:acme/app.git can read the whole board'
    );
  });
});
