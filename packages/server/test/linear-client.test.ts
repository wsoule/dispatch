import { describe, expect, it } from 'bun:test';

import { HttpLinearClient } from '../src/linear/client.js';

const KEY = 'lin_api_TESTKEY';

// Captures the outgoing request and replies with a canned body, so the client's
// wire format is asserted without any socket being opened.
function stubFetch(
  reply: { status?: number; body: unknown; headers?: Record<string, string> },
  seen: { init?: RequestInit; url?: string } = {}
): typeof fetch {
  return ((url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: {
          'content-type': 'application/json',
          ...(reply.headers ?? {}),
        },
      })
    );
  }) as unknown as typeof fetch;
}

describe('HttpLinearClient auth', () => {
  it('sends the personal key bare, with no Bearer prefix', async () => {
    const seen: { init?: RequestInit } = {};
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch(
        { body: { data: { viewer: { id: 'u', name: 'n', email: 'e' } } } },
        seen
      ),
    });
    const result = await client.viewer();

    expect(result.ok).toBe(true);
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(KEY);
    expect(headers.authorization).not.toContain('Bearer');
  });

  it('classifies an authentication failure as its own kind', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({
        status: 400,
        body: { errors: [{ message: 'Authentication required' }] },
      }),
    });
    const result = await client.viewer();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('auth');
  });
});

describe('HttpLinearClient rate limiting', () => {
  it('recognises RATELIMITED inside a 400 body, not just an HTTP 429', async () => {
    const resetAt = Date.now() + 42_000;
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({
        status: 400,
        body: {
          errors: [
            { message: 'Rate limit', extensions: { code: 'RATELIMITED' } },
          ],
        },
        headers: { 'x-ratelimit-requests-reset': String(resetAt) },
      }),
    });
    const result = await client.teams();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('rate-limit');
      expect(result.retryAfterMs).toBeGreaterThan(30_000);
      expect(result.retryAfterMs).toBeLessThanOrEqual(42_000);
    }
  });

  it('falls back to a flat minute when the reset header is unusable', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({
        status: 400,
        body: { errors: [{ extensions: { code: 'RATELIMITED' } }] },
      }),
    });
    const result = await client.teams();
    if (!result.ok) expect(result.retryAfterMs).toBe(60_000);
  });
});

describe('HttpLinearClient error text', () => {
  it('never lets the API key reach an error message', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({
        status: 400,
        body: { errors: [{ message: `bad key ${KEY} rejected` }] },
      }),
    });
    const result = await client.viewer();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(KEY);
      expect(result.error).toContain('[redacted]');
    }
  });

  it('reports a transport failure without throwing across the seam', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as never,
    });
    const result = await client.viewer();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('surfaces a failed mutation flag rather than reporting success', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({
        body: { data: { issueCreate: { success: false, issue: null } } },
      }),
    });
    const result = await client.createIssue({ teamId: 't', title: 'x' });
    expect(result.ok).toBe(false);
  });
});

// Reads back the `query`/`variables` payload the client posted, so a query's
// declared variable types can be asserted without a live API.
function sentQuery(seen: { init?: RequestInit }): string {
  const body = JSON.parse((seen.init?.body ?? '{}') as string) as {
    query?: string;
  };
  return body.query ?? '';
}

// Linear types a team id by position: `team(id:)` takes String!, while the id
// comparators inside a filter take ID. Declaring the wrong scalar makes the
// server reject the document at validation time, so the sync fails wholesale
// with "Variable '$teamId' of type 'String!' used in position expecting 'ID'".
describe('HttpLinearClient teamId variable types', () => {
  const filtered: Array<[string, (c: HttpLinearClient) => Promise<unknown>]> = [
    ['issuesUpdatedSince', (c) => c.issuesUpdatedSince('team-1', null)],
    ['issuesUpdatedSince since', (c) => c.issuesUpdatedSince('team-1', 'now')],
    ['issueLinks', (c) => c.issueLinks('team-1')],
  ];

  for (const [name, call] of filtered) {
    it(`declares $teamId as ID! for ${name}`, async () => {
      const seen: { init?: RequestInit } = {};
      const client = new HttpLinearClient(KEY, {
        fetchImpl: stubFetch(
          {
            body: {
              data: {
                issues: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
          seen
        ),
      });
      await call(client);

      const query = sentQuery(seen);
      expect(query).toContain('$teamId: ID!');
      expect(query).not.toContain('$teamId: String!');
    });
  }

  const lookups: Array<
    [string, (c: HttpLinearClient) => Promise<unknown>, unknown]
  > = [
    [
      'workflowStates',
      (c) => c.workflowStates('team-1'),
      { states: { nodes: [] } },
    ],
    ['labels', (c) => c.labels('team-1'), { labels: { nodes: [] } }],
  ];

  for (const [name, call, team] of lookups) {
    it(`keeps $teamId as String! for ${name}`, async () => {
      const seen: { init?: RequestInit } = {};
      const client = new HttpLinearClient(KEY, {
        fetchImpl: stubFetch({ body: { data: { team } } }, seen),
      });
      await call(client);

      const query = sentQuery(seen);
      expect(query).toContain('team(id: $teamId)');
      expect(query).toContain('$teamId: String!');
    });
  }
});

describe('HttpLinearClient pagination', () => {
  it('follows endCursor until hasNextPage goes false', async () => {
    let call = 0;
    const client = new HttpLinearClient(KEY, {
      fetchImpl: (() => {
        call++;
        const hasNextPage = call === 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                teams: {
                  nodes: [{ id: `t-${call}`, key: 'K', name: `Team ${call}` }],
                  pageInfo: { hasNextPage, endCursor: 'cursor-1' },
                },
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        );
      }) as unknown as typeof fetch,
    });

    const result = await client.teams();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((t) => t.id)).toEqual(['t-1', 't-2']);
    expect(call).toBe(2);
  });
});
