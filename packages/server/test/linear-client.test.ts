import { describe, expect, it } from 'bun:test';

import {
  HttpLinearClient,
  LINEAR_REQUEST_TIMEOUT_MS,
} from '../src/linear/client.js';

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
    ['probe', (c) => c.probe('team-1', 'now')],
    ['comments', (c) => c.comments('team-1', null)],
    ['comments since', (c) => c.comments('team-1', 'now')],
    ['projects', (c) => c.projects('team-1', null)],
    ['projects since', (c) => c.projects('team-1', 'now')],
    ['projectMilestones', (c) => c.projectMilestones('team-1', null)],
    ['projectMilestones since', (c) => c.projectMilestones('team-1', 'now')],
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
    [
      'workspace',
      (c) => c.workspace('team-1'),
      {
        id: 't',
        key: 'K',
        name: 'N',
        states: { nodes: [] },
        members: { nodes: [] },
      },
    ],
    [
      'cycles',
      (c) => c.cycles('team-1'),
      {
        cycles: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
  ];

  for (const [name, call, team] of lookups) {
    it(`keeps $teamId as String! for ${name}`, async () => {
      const seen: { init?: RequestInit } = {};
      const client = new HttpLinearClient(KEY, {
        fetchImpl: stubFetch(
          {
            body: {
              data: {
                team,
                viewer: { id: 'u', name: 'n', email: 'e' },
                projectStatuses: { nodes: [] },
              },
            },
          },
          seen
        ),
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

// Linear's published scoring: 0.1 per scalar, 1 per object, and a connection
// multiplies its children by `first`. A query over 10,000 points is rejected
// outright, so every document the client sends is checked against it here.
function estimateComplexity(query: string): number {
  const selection = query.slice(query.indexOf('{'));
  const tokens =
    selection.match(/\(|\)|\{|\}|first:\s*\d+|[A-Za-z_]\w*/g) ?? [];
  let i = 0;
  function block(): number {
    let total = 0;
    while (i < tokens.length && tokens[i] !== '}') {
      const token = tokens[i++];
      if (token === '{') continue;
      let first = 1;
      if (tokens[i] === '(') {
        while (tokens[i] !== ')') {
          const m = /^first:\s*(\d+)$/.exec(tokens[i]);
          if (m !== null) first = Number(m[1]);
          i++;
        }
        i++;
      }
      if (tokens[i] === '{') {
        i++;
        total += first * (1 + block());
        i++;
      } else if (!token.startsWith('first')) {
        total += 0.1;
      }
    }
    return total;
  }
  i = 1;
  return block();
}

describe('Linear query complexity', () => {
  it('keeps every query and mutation under the 10,000-point ceiling', async () => {
    const queries = await import('../src/linear/queries.js');
    const documents = Object.entries(queries).filter(
      ([, value]) =>
        typeof value === 'string' &&
        (value.startsWith('query') || value.startsWith('mutation'))
    ) as [string, string][];
    expect(documents.length).toBeGreaterThan(20);
    for (const [name, query] of documents) {
      const cost = estimateComplexity(query);
      if (cost >= 10_000) throw new Error(`${name} costs ~${cost}`);
    }
  });

  it('prices a full issue page at a real, non-trivial cost', async () => {
    const { ISSUES_QUERY } = await import('../src/linear/queries.js');
    const cost = estimateComplexity(ISSUES_QUERY);
    expect(cost).toBeGreaterThan(2_000);
    expect(cost).toBeLessThan(10_000);
  });
});

function issueNode(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'i-1',
    identifier: 'HYD-1',
    title: 'T',
    description: null,
    priority: 2,
    estimate: 3,
    url: 'https://linear.app/x/issue/HYD-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archivedAt: null,
    dueDate: '2026-02-01',
    state: {
      id: 's',
      name: 'Todo',
      type: 'unstarted',
      color: '#fff',
      position: 1,
    },
    team: { id: 'team-1', key: 'HYD' },
    assignee: { id: 'u-1' },
    creator: { id: 'u-2' },
    cycle: {
      id: 'c-1',
      number: 4,
      name: null,
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-01-15T00:00:00.000Z',
    },
    project: { id: 'p-1' },
    projectMilestone: null,
    parent: { id: 'i-0' },
    labels: {
      nodes: [{ id: 'l-1', name: 'bug' }],
      pageInfo: { hasNextPage: false },
    },
    relations: {
      nodes: [
        {
          id: 'r-1',
          type: 'blocks',
          issue: { id: 'i-1' },
          relatedIssue: { id: 'i-9' },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    inverseRelations: {
      nodes: [
        {
          id: 'r-2',
          type: 'duplicate',
          issue: { id: 'i-8' },
          relatedIssue: { id: 'i-1' },
        },
        {
          id: 'r-1',
          type: 'blocks',
          issue: { id: 'i-1' },
          relatedIssue: { id: 'i-9' },
        },
      ],
      pageInfo: { hasNextPage: true },
    },
    attachments: {
      nodes: [
        {
          id: 'a-1',
          title: 'PR',
          url: 'https://github.com/x/y/pull/1',
          subtitle: null,
          sourceType: 'github',
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    children: { nodes: [{ id: 'i-2' }], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

function page(key: string, nodes: unknown[]): unknown {
  return {
    data: {
      [key]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

describe('HttpLinearClient issue mapping', () => {
  it('flattens references and merges both relation directions', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({ body: page('issues', [issueNode()]) }),
    });
    const result = await client.issuesByIds(['i-1']);
    if (!result.ok) throw new Error(result.error);
    const [issue] = result.data;
    expect(issue.assigneeId).toBe('u-1');
    expect(issue.creatorId).toBe('u-2');
    expect(issue.projectId).toBe('p-1');
    expect(issue.projectMilestoneId).toBeNull();
    expect(issue.parentId).toBe('i-0');
    expect(issue.childIds).toEqual(['i-2']);
    expect(issue.estimate).toBe(3);
    expect(issue.dueDate).toBe('2026-02-01');
    expect(issue.cycle?.number).toBe(4);
    expect(issue.relations.map((r) => r.id).sort()).toEqual(['r-1', 'r-2']);
    expect(issue.relations.find((r) => r.id === 'r-2')).toEqual({
      id: 'r-2',
      type: 'duplicate',
      issueId: 'i-8',
      relatedIssueId: 'i-1',
    });
    expect(issue.attachments[0].url).toBe('https://github.com/x/y/pull/1');
  });

  it('marks a nested list the page cut short, and only that one', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({ body: page('issues', [issueNode()]) }),
    });
    const result = await client.issuesByIds(['i-1']);
    if (!result.ok) throw new Error(result.error);
    expect(result.data[0].truncated).toEqual(['relations']);
  });

  it('asks for ids a page at a time', async () => {
    const batches: number[] = [];
    const client = new HttpLinearClient(KEY, {
      fetchImpl: ((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          variables: { ids: string[] };
        };
        batches.push(body.variables.ids.length);
        return Promise.resolve(
          new Response(JSON.stringify(page('issues', [])), {
            headers: { 'content-type': 'application/json' },
          })
        );
      }) as unknown as typeof fetch,
    });
    const { ISSUE_PAGE } = await import('../src/linear/queries.js');
    const ids = Array.from({ length: ISSUE_PAGE * 2 + 5 }, (_, n) => `i-${n}`);
    await client.issuesByIds(ids);
    expect(batches).toEqual([ISSUE_PAGE, ISSUE_PAGE, 5]);
  });
});

describe('HttpLinearClient labels', () => {
  it('keeps the team’s and the workspace’s labels, never groups or other teams’', async () => {
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch({
        body: page('issueLabels', [
          {
            id: 'l-1',
            name: 'bug',
            color: '#f00',
            isGroup: false,
            team: { id: 'team-1' },
            parent: { name: 'Type' },
          },
          {
            id: 'l-2',
            name: 'infra',
            color: '#0f0',
            isGroup: false,
            team: null,
            parent: null,
          },
          {
            id: 'l-3',
            name: 'Type',
            color: '#00f',
            isGroup: true,
            team: { id: 'team-1' },
            parent: null,
          },
          {
            id: 'l-4',
            name: 'other',
            color: '#000',
            isGroup: false,
            team: { id: 'team-2' },
            parent: null,
          },
        ]),
      }),
    });
    const result = await client.labels('team-1');
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual([
      {
        id: 'l-1',
        name: 'bug',
        color: '#f00',
        group: 'Type',
        teamId: 'team-1',
      },
      { id: 'l-2', name: 'infra', color: '#0f0', group: null, teamId: null },
    ]);
  });
});

describe('HttpLinearClient label update', () => {
  it('recolors a label and reads it back with its group', async () => {
    const seen: { init?: RequestInit } = {};
    const client = new HttpLinearClient(KEY, {
      fetchImpl: stubFetch(
        {
          body: {
            data: {
              issueLabelUpdate: {
                success: true,
                issueLabel: {
                  id: 'l-1',
                  name: 'bug',
                  color: '#0f783c',
                  isGroup: false,
                  team: { id: 'team-1' },
                  parent: { name: 'Type' },
                },
              },
            },
          },
        },
        seen
      ),
    });
    const result = await client.updateLabel('l-1', { color: '#0f783c' });
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual({
      id: 'l-1',
      name: 'bug',
      color: '#0f783c',
      group: 'Type',
      teamId: 'team-1',
    });
    const body = JSON.parse((seen.init?.body ?? '{}') as string) as {
      query: string;
      variables: unknown;
    };
    expect(body.query).toContain('issueLabelUpdate(id: $id, input: $input)');
    expect(body.variables).toEqual({ id: 'l-1', input: { color: '#0f783c' } });
  });
});

describe('HttpLinearClient walk cap', () => {
  it('stops a walk that never ends and says so', async () => {
    let calls = 0;
    const client = new HttpLinearClient(KEY, {
      fetchImpl: (() => {
        calls++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: Array.from({ length: 40 }, (_, n) =>
                    issueNode({ id: `i-${calls}-${n}` })
                  ),
                  pageInfo: { hasNextPage: true, endCursor: `c-${calls}` },
                },
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        );
      }) as unknown as typeof fetch,
    });
    const result = await client.issuesUpdatedSince('team-1', null);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.truncated).toBe(true);
    expect(result.data.issues.length).toBe(12_000);
    expect(calls).toBe(300);
  });
});

describe('HttpLinearClient documents', () => {
  // Answers each request in turn from `replies`, recording what was sent.
  function sequence(replies: unknown[], sent: GraphqlSent[]): typeof fetch {
    return ((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as GraphqlSent);
      return Promise.resolve(
        new Response(JSON.stringify({ data: replies.shift() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as unknown as typeof fetch;
  }
  interface GraphqlSent {
    query: string;
    variables: Record<string, unknown>;
  }
  const node = {
    id: 'doc-1',
    title: 'Spec',
    content: '# Spec\n',
    updatedAt: '2026-09-26T10:00:00.000Z',
    updatedBy: { id: 'u-1' },
    documentContentId: 'dc-1',
    issue: null,
    project: { id: 'p-1' },
    initiative: null,
    cycle: null,
    release: null,
    team: null,
  };

  it('pages documents of the team updated since the cursor, parent mapped', async () => {
    const sent: GraphqlSent[] = [];
    const client = new HttpLinearClient(KEY, {
      fetchImpl: sequence(
        [
          {
            documents: {
              nodes: [
                node,
                { ...node, id: 'doc-2', project: null, updatedBy: null },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        ],
        sent
      ),
    });
    const result = await client.documents('team-1', '2026-09-01T00:00:00.000Z');
    expect(result.ok && result.data.nodes).toEqual([
      {
        id: 'doc-1',
        title: 'Spec',
        content: '# Spec\n',
        updatedAt: '2026-09-26T10:00:00.000Z',
        updatedBy: 'u-1',
        parent: { kind: 'project', id: 'p-1' },
      },
      {
        id: 'doc-2',
        title: 'Spec',
        content: '# Spec\n',
        updatedAt: '2026-09-26T10:00:00.000Z',
        updatedBy: null,
        parent: null,
      },
    ]);
    expect(sent[0].variables).toMatchObject({
      teamId: 'team-1',
      since: '2026-09-01T00:00:00.000Z',
    });
    expect(sent[0].query).toContain('documents(');
  });

  it('updates and creates with markdown content, and reads history by content id', async () => {
    const sent: GraphqlSent[] = [];
    const client = new HttpLinearClient(KEY, {
      fetchImpl: sequence(
        [
          { documentUpdate: { success: true, document: node } },
          { documentCreate: { success: true, document: node } },
          { document: node },
          {
            documentContentHistory: {
              success: true,
              history: [
                {
                  contentDataSnapshotAt: '2026-09-26T10:01:00.000Z',
                  actorIds: ['u-2'],
                },
              ],
            },
          },
        ],
        sent
      ),
    });
    expect((await client.updateDocument('doc-1', 'x\n')).ok).toBe(true);
    expect(sent[0].variables).toEqual({
      id: 'doc-1',
      input: { content: 'x\n' },
    });
    const made = await client.createDocument({
      title: 'Spec',
      content: 'x\n',
      issueId: 'iss-1',
    });
    expect(made.ok && made.data.id).toBe('doc-1');
    expect(sent[1].variables).toEqual({
      input: { title: 'Spec', content: 'x\n', issueId: 'iss-1' },
    });
    const history = await client.documentContentHistory('doc-1');
    expect(history.ok && history.data).toEqual([
      { contentDataSnapshotAt: '2026-09-26T10:01:00.000Z', actorIds: ['u-2'] },
    ]);
    expect(sent[3].variables).toEqual({ id: 'dc-1' });
  });
});

describe('HttpLinearClient timeout', () => {
  it('gives up on a request Linear never answers, as a network failure', async () => {
    const hung = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      })) as unknown as typeof fetch;
    const client = new HttpLinearClient(KEY, {
      fetchImpl: hung,
      timeoutMs: 20,
    });
    const result = await client.viewer();
    expect(result).toMatchObject({ ok: false, kind: 'network' });
  });

  it('defaults to a timeout well under the share claim', () => {
    expect(LINEAR_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
