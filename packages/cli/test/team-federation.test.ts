import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/apiClient.js';
import type { TeamKeys } from '../src/apiClient.js';
import { describeTeamKeys } from '../src/commands/team.js';

let server: ReturnType<typeof Bun.serve>;
const seen: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  seen.length = 0;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname,
        body: text === '' ? null : JSON.parse(text),
      });
      return Response.json({
        ok: true,
        teamId: 't'.repeat(32),
        recoveryCode: 'X',
        fingerprint: 'F',
        code: 'di1.x',
        expires: 'e',
      });
    },
  });
});
afterEach(() => server.stop(true));

const keys: TeamKeys = {
  machine: {
    replica: 'bob-0000000b',
    handle: 'bob',
    device: 'desk',
    fingerprint: '7QX2-K9PA-M3TD-0W4R-HB8E-5NCF',
  },
  team: {
    id: 'a'.repeat(32),
    name: 'acme',
    founder: {
      replica: 'ada-0000000a',
      handle: 'ada',
      fingerprint: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    },
  },
  foundings: [],
  roster: [
    {
      replica: 'ada-0000000a',
      handle: 'ada',
      device: 'laptop',
      build: '0.40.0',
      role: 'admin',
      rank: 0,
      hosts: [],
      observer: false,
      recovered: false,
      fingerprint: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
      lastSeen: null,
      skewMs: null,
    },
  ],
  waiting: [
    {
      replica: 'cy-0000000c',
      handle: 'cy',
      device: 'mini',
      fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC',
      invitedBy: 'ada',
    },
  ],
  invites: [],
  legacy: { until: '2026-10-26T00:00:00.000Z', closed: false, olderBuilds: [] },
  transport: {
    kind: 'git',
    lastExchangeAt: null,
    lastError: null,
    unpublished: 0,
    sizeBytes: 1024,
    acks: {},
  },
  license: { seats: 3, org: null, sharedBy: null },
  pruningBlockers: [],
  originWarning: null,
  relayDisclosure: 'The relay can read everything that is not sealed',
  warnings: [
    'Only ada can admit, revoke or change the team. Make a second person an admin, or keep the recovery code safe.',
  ],
  problems: [],
};

describe('dispatch team keys output', () => {
  it('names this machine, the founder to verify with, the waiting keys and the warnings', () => {
    const text = describeTeamKeys(keys).join('\n');
    expect(text).toContain('This machine: 7QX2-K9PA-M3TD-0W4R-HB8E-5NCF');
    expect(text).toContain(
      'Founder: ada (AAAA-BBBB-CCCC-DDDD-EEEE-FFFF), verify this with ada'
    );
    expect(text).toContain(
      'Waiting to join: cy on mini, CCCC-CCCC-CCCC-CCCC-CCCC-CCCC, invited by ada'
    );
    expect(text).toContain('Only ada can admit, revoke or change the team.');
  });
});

describe('the API client', () => {
  it('reaches each federation route with the right method and body', async () => {
    const client = createApiClient(
      `http://127.0.0.1:${server.port}`,
      'app-token'
    );
    await client.foundTeam('acme');
    await client.admitReplica('cy-0000000c', {
      fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC',
      role: 'admin',
    });
    await client.revokeReplica('cy-0000000c', 'left');
    await client.inviteToTeam('dee');
    await client.abandonInvite();
    await client.dismissRosterOp('cy-0000000c', 4, 'h'.repeat(64));
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ['POST', '/api/team/found', { name: 'acme' }],
      [
        'POST',
        '/api/team/keys/cy-0000000c/admit',
        { fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC', role: 'admin' },
      ],
      ['POST', '/api/team/keys/cy-0000000c/revoke', { reason: 'left' }],
      ['POST', '/api/team/invite', { handle: 'dee' }],
      ['POST', '/api/team/abandon-invite', {}],
      [
        'POST',
        '/api/team/dismiss',
        { replica: 'cy-0000000c', seq: 4, hash: 'h'.repeat(64) },
      ],
    ]);
  });
});
