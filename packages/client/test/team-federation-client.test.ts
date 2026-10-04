import { describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/api';
import type { TeamKeys } from '../src/api';

// The stubFetch and sentJson helpers, copied from messaging-client.test.ts,
// which keeps them local.
function stubFetch(responseBody: unknown = {}): {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((
    url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function sentJson(call: { init?: RequestInit }): unknown {
  const body = call.init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected a JSON string body, got ${typeof body}`);
  }
  return JSON.parse(body);
}

const BASE = 'http://example.test';

describe('team federation bindings', () => {
  it('reaches each federation route with its method and body, and percent-encodes the replica', async () => {
    const stub = stubFetch({
      teamId: 't',
      recoveryCode: 'R',
      fingerprint: 'F',
      code: 'di1.x',
      expires: 'e',
    });
    try {
      const client = createApiClient(BASE, 'app-token');
      await client.foundTeam('acme');
      await client.trustFounder('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
      await client.admitReplica('cy-0000000c', {
        fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC',
      });
      await client.setReplicaHosts('box-0000000d', ['eve']);
      await client.closeLegacy();
      await client.revokeReplica('a/b', 'left');
      await client.dismissRosterOp('cy-0000000c', 4, 'h');
      await client.ackProblem('team:race:bob-0000000b');
      expect(stub.calls.map((c) => [c.init?.method, c.url])).toEqual([
        ['POST', `${BASE}/api/team/found`],
        ['POST', `${BASE}/api/team/trust`],
        ['POST', `${BASE}/api/team/keys/cy-0000000c/admit`],
        ['POST', `${BASE}/api/team/keys/box-0000000d/hosts`],
        ['POST', `${BASE}/api/team/close-legacy`],
        ['POST', `${BASE}/api/team/keys/a%2Fb/revoke`],
        ['POST', `${BASE}/api/team/dismiss`],
        ['POST', `${BASE}/api/team/problems/ack`],
      ]);
      expect(sentJson(stub.calls[3] ?? {})).toEqual({ hosts: ['eve'] });
      expect(sentJson(stub.calls[6] ?? {})).toEqual({
        replica: 'cy-0000000c',
        seq: 4,
        hash: 'h',
      });
    } finally {
      stub.restore();
    }
  });

  it('reads the team keys as the server sends them', async () => {
    const keys = {
      machine: {
        replica: 'ada-0000000a',
        handle: 'ada',
        device: 'laptop',
        fingerprint: 'F',
      },
      team: null,
      foundings: [],
      roster: [],
      waiting: [],
      invites: [],
      legacy: { until: null, closed: false, olderBuilds: [] },
      transport: {
        kind: 'git',
        lastExchangeAt: null,
        lastError: null,
        unpublished: 0,
        sizeBytes: null,
        readBytes: 0,
        acks: {},
      },
      license: null,
      pruningBlockers: [],
      originWarning: null,
      relayDisclosure: 'R',
      warnings: [],
      problems: [],
      pause: null,
    } satisfies TeamKeys;
    const stub = stubFetch(keys);
    try {
      expect(await createApiClient(BASE, 'app-token').getTeamKeys()).toEqual(
        keys
      );
      expect(stub.calls[0]?.url).toBe(`${BASE}/api/team/keys`);
    } finally {
      stub.restore();
    }
  });
});
