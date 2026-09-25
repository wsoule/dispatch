import { describe, expect, test } from 'bun:test';

import { describeSync } from '../src/commands/boardSync.js';
import { describeLicense } from '../src/commands/license.js';

describe('describeSync', () => {
  test('off says how to turn it on', () => {
    expect(
      describeSync({ enabled: false, reason: 'off' }).join('\n')
    ).toContain('sync: { enabled: true }');
    // An older daemon doesn't say why; off is the likely reason.
    expect(describeSync({ enabled: false }).join('\n')).toContain(
      'sync: { enabled: true }'
    );
  });

  // Both switches push with the owner's git credentials, so the daemon lets
  // only the person running it flip them from Settings.
  test('says who can turn sharing or committing on', () => {
    for (const reason of ['off', 'files'] as const) {
      expect(describeSync({ enabled: false, reason }).join('\n')).toContain(
        'The person running Dispatch for this project'
      );
    }
  });

  // Turning sync on does nothing for a board kept as files.
  test('a board kept as files is pointed at committing its task files', () => {
    const lines = describeSync({ enabled: false, reason: 'files' }).join('\n');
    expect(lines).toContain('Commit task files to the main branch');
    expect(lines).not.toContain('sync: { enabled: true }');
  });

  test('on but not started says what to check, not to turn it on', () => {
    const lines = describeSync({ enabled: false, reason: 'not-started' }).join(
      '\n'
    );
    expect(lines).toContain("isn't running");
    expect(lines).not.toContain('Turn it on');
  });

  test('on says where, when, what is waiting, and what went wrong', () => {
    const lines = describeSync({
      enabled: true,
      replica: 'ada-1a2b3c4d',
      remote: 'git@example.com:team/repo.git',
      branch: 'dispatch-sync',
      lastSyncAt: '2026-09-23T10:00:00.000Z',
      lastError: 'Could not resolve host',
      pending: 3,
      applied: 12,
      problems: [
        {
          task: 't-abc12345',
          message: 'created separately on two machines',
          at: 'x',
        },
      ],
      people: 2,
      seats: 3,
      paused: null,
    }).join('\n');
    expect(lines).toContain('ada-1a2b3c4d');
    expect(lines).toContain('Could not resolve host');
    expect(lines).toContain('3 change(s) waiting');
    expect(lines).toContain('t-abc12345');
  });

  test('past the seats it says so, in the daemon’s words', () => {
    const lines = describeSync({
      enabled: true,
      replica: 'barbara-1a2b3c4d',
      remote: 'git@example.com:team/repo.git',
      branch: 'dispatch-sync',
      lastSyncAt: null,
      lastError: null,
      pending: 1,
      applied: 0,
      problems: [],
      people: 4,
      seats: 3,
      paused: 'Board sync is paused on this machine: the free plan covers 3.',
    }).join('\n');
    expect(lines).toContain('Board sync is paused on this machine');
    expect(lines).not.toContain('could not be reached');
  });
});

describe('describeLicense', () => {
  const base = { used: 2, org: null, expiresAt: null, reason: null };

  test('the free plan and how full it is', () => {
    expect(describeLicense({ ...base, kind: 'free', seats: 3 })).toEqual([
      'Free plan: up to 3 people.',
      '2 of 3 seats in use.',
    ]);
  });

  test('a license names who and until when', () => {
    expect(
      describeLicense({
        ...base,
        kind: 'licensed',
        seats: 10,
        org: 'Acme',
        expiresAt: '2027-09-23T00:00:00.000Z',
      })[0]
    ).toBe('Licensed to Acme for 10 people, until 2027-09-23.');
  });

  test('an expired or refused key says what happened', () => {
    expect(
      describeLicense({
        ...base,
        kind: 'expired',
        seats: 3,
        org: 'Acme',
        expiresAt: '2026-09-01T00:00:00.000Z',
      }).join('\n')
    ).toContain('expired on 2026-09-01; the free plan applies');
    expect(
      describeLicense({
        ...base,
        kind: 'invalid',
        seats: 3,
        reason: 'the signature does not match',
      }).join('\n')
    ).toContain('not accepted: the signature does not match');
  });
});
