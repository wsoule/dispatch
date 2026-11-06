import { describe, expect, test } from 'bun:test';

import { LinearApiError } from '../../src/planner/linear/gateway.js';
import { createLinearGateway } from '../../src/planner/linear/linear-gateway.js';
import {
  PAGE_SIZE,
  STATE_CHANGE_BATCH_SIZE,
} from '../../src/planner/linear/queries.js';
import {
  caught,
  connection,
  dataResponse,
  graphqlFetch,
  type GraphqlHandler,
  issueNode,
  jsonResponse,
  milestoneNode,
  noSleep,
  pagedHandler,
  projectNode,
  relationNode,
  userNode,
  workspaceHandlers,
} from './helpers.js';

const TOKEN = 'test-token';

const identity: GraphqlHandler = () =>
  dataResponse({
    viewer: userNode('user-1'),
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  });

function emptyWorkspaceHandlers(): Record<string, GraphqlHandler> {
  return workspaceHandlers();
}

function gatewayWith(handlers: Record<string, GraphqlHandler>) {
  const fake = graphqlFetch(handlers);
  const gateway = createLinearGateway({
    accessToken: TOKEN,
    fetch: fake.fetch,
    sleep: noSleep,
  });
  return { gateway, calls: fake.calls };
}

describe('whoAmI', () => {
  test('maps viewer and organization', async () => {
    const { gateway } = gatewayWith({ Identity: identity });
    expect(await gateway.whoAmI()).toEqual({
      user: {
        id: 'user-1',
        name: 'Name user-1',
        displayName: 'user-1',
        email: 'user-1@example.com',
        avatarUrl: null,
        active: true,
        app: false,
        guest: false,
      },
      workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    });
  });
});

describe('fetchWorkspace', () => {
  test('pages every connection, passing first and the previous endCursor', async () => {
    const handlers = emptyWorkspaceHandlers();
    handlers['Users'] = pagedHandler('users', [
      [userNode('u1'), userNode('u2')],
      [userNode('u3')],
      [userNode('u4', { active: false })],
    ]);
    handlers['ProjectIssues'] = pagedHandler('issues', [
      [issueNode('1')],
      [issueNode('2')],
    ]);
    handlers['Projects'] = pagedHandler('projects', [[projectNode('proj-1')]]);
    const { gateway, calls } = gatewayWith(handlers);
    const data = await gateway.fetchWorkspace();

    expect(data.workspaceId).toBe('org-1');
    // The name and URL key Linear reports now (the installation follows).
    expect(data.organization).toEqual({ name: 'Acme', urlKey: 'acme' });
    expect(data.users.map((u) => u.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(data.issues.map((i) => i.id)).toEqual(['1', '2']);

    const userCalls = calls.filter((c) => c.operation === 'Users');
    expect(userCalls.map((c) => c.variables)).toEqual([
      { first: PAGE_SIZE, after: null },
      { first: PAGE_SIZE, after: 'c1' },
      { first: PAGE_SIZE, after: 'c2' },
    ]);
    const issueCalls = calls.filter((c) => c.operation === 'ProjectIssues');
    expect(issueCalls.map((c) => c.variables['after'])).toEqual([null, 'c1']);
    // Every root connection was requested at least once.
    for (const op of Object.keys(handlers)) {
      expect(calls.some((c) => c.operation === op)).toBe(true);
    }
  });

  test('maps every entity type and keeps only "blocks" relations', async () => {
    const handlers = emptyWorkspaceHandlers();
    handlers['Teams'] = pagedHandler('teams', [
      [
        {
          id: 'team-1',
          key: 'ENG',
          name: 'Engineering',
          visibility: 'public',
          parent: null,
        },
        {
          id: 'team-2',
          key: 'SEC',
          name: 'Security',
          visibility: 'private',
          parent: { id: 'team-1' },
        },
      ],
    ]);
    // Memberships across pages, a repeated one counted once.
    handlers['TeamMemberships'] = pagedHandler('teamMemberships', [
      [
        { team: { id: 'team-1' }, user: { id: 'u1' } },
        { team: { id: 'team-2' }, user: { id: 'u2' } },
      ],
      [
        { team: { id: 'team-1' }, user: { id: 'u2' } },
        { team: { id: 'team-1' }, user: { id: 'u1' } },
      ],
    ]);
    handlers['WorkflowStates'] = pagedHandler('workflowStates', [
      [
        {
          id: 's1',
          name: 'Todo',
          type: 'unstarted',
          position: 1,
          team: { id: 'team-1' },
        },
        {
          id: 's2',
          name: 'Duplicate',
          type: 'duplicate',
          position: 9,
          team: { id: 'team-1' },
        },
      ],
    ]);
    handlers['Initiatives'] = pagedHandler('initiatives', [
      [
        {
          id: 'init-1',
          name: 'Init',
          sortOrder: 1,
          priority: 2,
          targetDate: null,
        },
      ],
    ]);
    handlers['Projects'] = pagedHandler('projects', [[projectNode('proj-1')]]);
    handlers['ProjectMilestones'] = pagedHandler('projectMilestones', [
      [
        milestoneNode('ms-1'),
        milestoneNode('ms-orphan', { project: { id: 'proj-gone' } }),
      ],
    ]);
    handlers['ProjectIssues'] = pagedHandler('issues', [
      [issueNode('1'), issueNode('orphan', { project: { id: 'proj-gone' } })],
    ]);
    handlers['OpenIssuesWithoutProject'] = pagedHandler('issues', [
      [issueNode('loose', { project: null, projectMilestone: null })],
    ]);
    handlers['IssueRelations'] = pagedHandler('issueRelations', [
      [
        relationNode('r1', 'blocks', '1', '2'),
        relationNode('r2', 'related', '1', '2'),
      ],
      [
        relationNode('r3', 'duplicate', '2', '1'),
        relationNode('r4', 'blocks', 'x', 'y'),
      ],
    ]);
    const { gateway } = gatewayWith(handlers);
    const data = await gateway.fetchWorkspace();

    expect(data.teams).toEqual([
      {
        id: 'team-1',
        key: 'ENG',
        name: 'Engineering',
        visibility: 'public',
        parentId: null,
        memberIds: ['u1', 'u2'],
      },
      {
        id: 'team-2',
        key: 'SEC',
        name: 'Security',
        visibility: 'private',
        parentId: 'team-1',
        memberIds: ['u2'],
      },
    ]);
    expect(data.states.map((s) => [s.id, s.type])).toEqual([
      ['s1', 'unstarted'],
      ['s2', 'canceled'],
    ]);
    expect(data.initiatives[0]?.priority).toBe(2);
    expect(data.projects.map((p) => p.id)).toEqual(['proj-1']);
    // Milestones/issues of projects that are not mirrored are left out.
    expect(data.milestones.map((m) => m.id)).toEqual(['ms-1']);
    expect(data.issues.map((i) => i.id)).toEqual(['1', 'loose']);
    // Relations across pages, "blocks" only; unmirrored ends are core's job.
    expect(data.relations).toEqual([
      { id: 'r1', blockerId: '1', blockedId: '2' },
      { id: 'r4', blockerId: 'x', blockedId: 'y' },
    ]);
  });

  test('a repeated cursor aborts instead of looping forever', async () => {
    const handlers = emptyWorkspaceHandlers();
    handlers['Teams'] = () => dataResponse({ teams: connection([], 'same') });
    const { gateway } = gatewayWith(handlers);
    expect(await caught(gateway.fetchWorkspace())).toBeInstanceOf(
      LinearApiError
    );
  });

  test('hasNextPage without an endCursor aborts instead of truncating', async () => {
    // A cut-off list would make the engine drop every issue it did not see.
    const handlers = emptyWorkspaceHandlers();
    handlers['ProjectIssues'] = () =>
      dataResponse({
        issues: {
          nodes: [issueNode('1')],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      });
    const { gateway, calls } = gatewayWith(handlers);
    const error = await caught(gateway.fetchWorkspace());
    expect(error).toBeInstanceOf(LinearApiError);
    expect(error).toMatchObject({ kind: 'graphql' });
    expect(calls.filter((c) => c.operation === 'ProjectIssues')).toHaveLength(
      1
    );
  });
});

describe('fetchLastStateChanges', () => {
  // Answers aliased batches from a per-issue table of stateHistory spans.
  function spansHandler(spans: Record<string, unknown[]>): GraphqlHandler {
    return (variables) => {
      const data: Record<string, unknown> = {};
      for (const [name, id] of Object.entries(variables)) {
        const alias = `i${name.slice(2)}`;
        data[alias] = { id, stateHistory: connection(spans[String(id)] ?? []) };
      }
      return dataResponse(data);
    };
  }

  test('picks the span with endedAt null wherever it sits', async () => {
    const { gateway, calls } = gatewayWith({
      IssueStateSpans: spansHandler({
        a: [
          { startedAt: '2026-10-10T00:00:00.000Z', endedAt: null },
          {
            startedAt: '2026-10-01T00:00:00.000Z',
            endedAt: '2026-10-10T00:00:00.000Z',
          },
        ],
        b: [
          {
            startedAt: '2026-09-01T00:00:00.000Z',
            endedAt: '2026-09-05T00:00:00.000Z',
          },
          {
            startedAt: '2026-09-05T00:00:00.000Z',
            endedAt: '2026-10-02T00:00:00.000Z',
          },
          { startedAt: '2026-10-02T00:00:00Z' },
        ],
      }),
    });
    const result = await gateway.fetchLastStateChanges(['a', 'b']);
    expect(result).toEqual(
      new Map([
        ['a', '2026-10-10T00:00:00.000Z'],
        ['b', '2026-10-02T00:00:00.000Z'],
      ])
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual({ id0: 'a', id1: 'b' });
    expect(calls[0]?.query).toContain('i1: issue(id: $id1)');
  });

  test('batches at most STATE_CHANGE_BATCH_SIZE issues per request, deduped', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `x${i}`);
    const spans: Record<string, unknown[]> = {};
    for (const id of ids)
      spans[id] = [{ startedAt: '2026-10-01T00:00:00.000Z', endedAt: null }];
    const { gateway, calls } = gatewayWith({
      IssueStateSpans: spansHandler(spans),
    });
    const result = await gateway.fetchLastStateChanges([...ids, 'x0', 'x1']);
    expect(result.size).toBe(45);
    expect(calls.map((c) => Object.keys(c.variables).length)).toEqual([
      STATE_CHANGE_BATCH_SIZE,
      STATE_CHANGE_BATCH_SIZE,
      5,
    ]);
  });

  test('falls back to history (newest entry with toStateId) when no open span', async () => {
    const { gateway, calls } = gatewayWith({
      IssueStateSpans: spansHandler({
        a: [],
        b: [{ startedAt: '2026-10-05T00:00:00.000Z', endedAt: null }],
      }),
      IssueStateHistory: (variables) =>
        dataResponse({
          i0: {
            id: variables['id0'],
            history: connection([
              { createdAt: '2026-10-03T00:00:00.000Z', toStateId: 's2' },
              { createdAt: '2026-10-09T00:00:00.000Z', toStateId: null },
              { createdAt: '2026-10-01T00:00:00.000Z', toStateId: 's1' },
            ]),
          },
        }),
    });
    const result = await gateway.fetchLastStateChanges(['a', 'b']);
    expect(result.get('a')).toBe('2026-10-03T00:00:00.000Z');
    expect(result.get('b')).toBe('2026-10-05T00:00:00.000Z');
    const historyCall = calls.find((c) => c.operation === 'IssueStateHistory');
    expect(historyCall?.variables).toEqual({ id0: 'a' });
  });

  test('follows stateHistory pages when the open span is not on the first one', async () => {
    const { gateway, calls } = gatewayWith({
      IssueStateSpans: () =>
        dataResponse({
          i0: {
            id: 'a',
            stateHistory: connection(
              [
                {
                  startedAt: '2026-09-01T00:00:00.000Z',
                  endedAt: '2026-09-02T00:00:00.000Z',
                },
              ],
              'p2'
            ),
          },
        }),
      IssueStateSpansPage: (variables) => {
        expect(variables).toEqual({ id: 'a', after: 'p2' });
        return dataResponse({
          issue: {
            id: 'a',
            stateHistory: connection([
              { startedAt: '2026-10-07T00:00:00.000Z', endedAt: null },
            ]),
          },
        });
      },
    });
    expect(await gateway.fetchLastStateChanges(['a'])).toEqual(
      new Map([['a', '2026-10-07T00:00:00.000Z']])
    );
    expect(calls.map((c) => c.operation)).toEqual([
      'IssueStateSpans',
      'IssueStateSpansPage',
    ]);
  });

  test('a deleted issue in a batch is dropped and the rest retried', async () => {
    let attempts = 0;
    const { gateway } = gatewayWith({
      IssueStateSpans: (variables) => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(
            {
              data: null,
              errors: [
                {
                  message: 'Entity not found: Issue',
                  path: ['i1'],
                  extensions: { code: 'INPUT_ERROR' },
                },
              ],
            },
            { status: 400 }
          );
        }
        expect(variables).toEqual({ id0: 'a', id1: 'c' });
        return spansHandler({
          a: [{ startedAt: '2026-10-01T00:00:00.000Z', endedAt: null }],
          c: [{ startedAt: '2026-10-02T00:00:00.000Z', endedAt: null }],
        })(variables, {} as never);
      },
      IssueStateHistory: () =>
        jsonResponse(
          {
            data: null,
            errors: [
              {
                message: 'Entity not found: Issue',
                path: ['i0'],
                extensions: { code: 'INPUT_ERROR' },
              },
            ],
          },
          { status: 400 }
        ),
    });
    const result = await gateway.fetchLastStateChanges(['a', 'gone', 'c']);
    expect([...result.keys()].sort()).toEqual(['a', 'c']);
  });

  test('a field error next to data sets that alias aside, not the batch', async () => {
    const seen: unknown[] = [];
    const { gateway } = gatewayWith({
      IssueStateSpans: (variables) => {
        seen.push(variables);
        if (seen.length === 1) {
          // b's stateHistory failed; Linear nulls it and says where.
          return jsonResponse({
            data: {
              i0: {
                id: 'a',
                stateHistory: connection([
                  { startedAt: '2026-10-01T00:00:00.000Z', endedAt: null },
                ]),
              },
              i1: { id: 'b', stateHistory: null },
            },
            errors: [
              { message: 'Internal error', path: ['i1', 'stateHistory'] },
            ],
          });
        }
        return spansHandler({
          a: [{ startedAt: '2026-10-01T00:00:00.000Z', endedAt: null }],
        })(variables, {} as never);
      },
      IssueStateHistory: () =>
        dataResponse({
          i0: {
            id: 'b',
            history: connection([
              { createdAt: '2026-10-05T00:00:00.000Z', toStateId: 's' },
            ]),
          },
        }),
    });
    expect(await gateway.fetchLastStateChanges(['a', 'b'])).toEqual(
      new Map([
        ['a', '2026-10-01T00:00:00.000Z'],
        ['b', '2026-10-05T00:00:00.000Z'],
      ])
    );
    expect(seen).toEqual([{ id0: 'a', id1: 'b' }, { id0: 'a' }]);
  });

  test('a stateHistory failure for the whole batch falls back to history', async () => {
    const { gateway } = gatewayWith({
      IssueStateSpans: () =>
        jsonResponse({
          data: null,
          errors: [{ message: 'Feature not accessible' }],
        }),
      IssueStateHistory: () =>
        dataResponse({
          i0: {
            id: 'a',
            history: connection([
              { createdAt: '2026-10-04T00:00:00.000Z', toStateId: 's' },
            ]),
          },
        }),
    });
    expect(await gateway.fetchLastStateChanges(['a'])).toEqual(
      new Map([['a', '2026-10-04T00:00:00.000Z']])
    );
  });

  test('a failing stateHistory page falls back to history for that issue only', async () => {
    const { gateway, calls } = gatewayWith({
      IssueStateSpans: () =>
        dataResponse({
          i0: {
            id: 'a',
            stateHistory: connection(
              [
                {
                  startedAt: '2026-09-01T00:00:00.000Z',
                  endedAt: '2026-09-02T00:00:00.000Z',
                },
              ],
              'p2'
            ),
          },
          i1: {
            id: 'b',
            stateHistory: connection([
              { startedAt: '2026-10-08T00:00:00.000Z', endedAt: null },
            ]),
          },
        }),
      IssueStateSpansPage: () =>
        jsonResponse({ data: null, errors: [{ message: 'Cursor expired' }] }),
      IssueStateHistory: (variables) => {
        expect(variables).toEqual({ id0: 'a' });
        return dataResponse({
          i0: {
            id: 'a',
            history: connection([
              { createdAt: '2026-10-06T00:00:00.000Z', toStateId: 's' },
            ]),
          },
        });
      },
    });
    expect(await gateway.fetchLastStateChanges(['a', 'b'])).toEqual(
      new Map([
        ['b', '2026-10-08T00:00:00.000Z'],
        ['a', '2026-10-06T00:00:00.000Z'],
      ])
    );
    expect(calls.map((c) => c.operation)).toEqual([
      'IssueStateSpans',
      'IssueStateSpansPage',
      'IssueStateHistory',
    ]);
  });

  // No open state span for `a`, so the lookup falls back to history, whose
  // pages are served by `historyPage(after)`.
  function historyOnly(
    first: unknown,
    historyPage: (after: string) => unknown
  ): Record<string, GraphqlHandler> {
    return {
      IssueStateSpans: spansHandler({ a: [] }),
      IssueStateHistory: () =>
        dataResponse({ i0: { id: 'a', history: first } }),
      IssueHistoryPage: (variables) =>
        dataResponse({
          issue: { id: 'a', history: historyPage(String(variables['after'])) },
        }),
    };
  }

  test('a multi-page history returns the newest state change across pages', async () => {
    const { gateway, calls } = gatewayWith(
      historyOnly(
        connection(
          [{ createdAt: '2026-10-02T00:00:00.000Z', toStateId: 's1' }],
          'h1'
        ),
        () =>
          connection([
            { createdAt: '2026-10-09T00:00:00.000Z', toStateId: 's2' },
          ])
      )
    );
    expect(await gateway.fetchLastStateChanges(['a'])).toEqual(
      new Map([['a', '2026-10-09T00:00:00.000Z']])
    );
    expect(calls.map((c) => c.operation)).toEqual([
      'IssueStateSpans',
      'IssueStateHistory',
      'IssueHistoryPage',
    ]);
  });

  test('a history longer than the pages read gives no answer, not a stale one', async () => {
    // The order of history entries is undocumented, so the newest change
    // may sit on a page that was never read.
    let page = 0;
    const { gateway, calls } = gatewayWith(
      historyOnly(
        connection(
          [{ createdAt: '2026-09-01T00:00:00.000Z', toStateId: 's1' }],
          'h0'
        ),
        () => {
          page += 1;
          return connection(
            [{ createdAt: '2026-09-02T00:00:00.000Z', toStateId: null }],
            `h${page}`
          );
        }
      )
    );
    expect(await gateway.fetchLastStateChanges(['a'])).toEqual(new Map());
    // The first page plus the bounded number of extra pages, then it stops.
    expect(calls.filter((c) => c.operation === 'IssueHistoryPage').length).toBe(
      4
    );
  });

  test('a history page without a cursor skips that issue only', async () => {
    const { gateway } = gatewayWith(
      historyOnly(
        {
          nodes: [{ createdAt: '2026-09-01T00:00:00.000Z', toStateId: 's1' }],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
        () => connection([])
      )
    );
    expect(await gateway.fetchLastStateChanges(['a'])).toEqual(new Map());
  });

  test('a repeated nested cursor aborts', async () => {
    const { gateway } = gatewayWith({
      Project: () =>
        dataResponse({
          project: {
            ...projectNode('proj-1'),
            archivedAt: null,
            projectMilestones: connection([milestoneNode('ms-1')], 'same'),
          },
        }),
      ProjectMilestonesPage: () =>
        dataResponse({
          project: {
            id: 'proj-1',
            projectMilestones: connection([milestoneNode('ms-2')], 'same'),
          },
        }),
    });
    expect(await caught(gateway.fetchProject('proj-1'))).toBeInstanceOf(
      LinearApiError
    );
  });

  test('rate limits are not swallowed by the fallback', async () => {
    const fake = graphqlFetch({
      IssueStateSpans: () =>
        jsonResponse(
          {
            errors: [
              { message: 'Rate limited', extensions: { code: 'RATELIMITED' } },
            ],
          },
          {
            status: 400,
            headers: {
              'x-ratelimit-requests-reset': String(Date.now() + 3_600_000),
            },
          }
        ),
    });
    const gateway = createLinearGateway({
      accessToken: TOKEN,
      fetch: fake.fetch,
      sleep: noSleep,
    });
    expect(await caught(gateway.fetchLastStateChanges(['a']))).toMatchObject({
      kind: 'rate_limited',
    });
  });
});

describe('single-entity reads', () => {
  const notFound: GraphqlHandler = () =>
    jsonResponse(
      {
        data: null,
        errors: [
          { message: 'Entity not found', extensions: { code: 'INPUT_ERROR' } },
        ],
      },
      { status: 400 }
    );

  test('fetchIssue fails on partial data instead of reading a failed field as empty', async () => {
    const { gateway } = gatewayWith({
      Issue: (variables) =>
        jsonResponse({
          data: {
            issue: {
              ...issueNode(String(variables['id'])),
              assignee: null,
              archivedAt: null,
              trashed: false,
            },
          },
          errors: [{ message: 'Internal error', path: ['issue', 'assignee'] }],
        }),
    });
    expect(await caught(gateway.fetchIssue('issue-1'))).toMatchObject({
      kind: 'graphql',
    });
  });

  test('fetchIssue maps, and returns null when not found or archived', async () => {
    let mode: 'ok' | 'archived' | 'missing' = 'ok';
    const { gateway } = gatewayWith({
      Issue: (variables, call) => {
        if (mode === 'missing') return notFound(variables, call);
        return dataResponse({
          issue: {
            ...issueNode(String(variables['id'])),
            archivedAt: mode === 'archived' ? '2026-10-01T00:00:00Z' : null,
            trashed: false,
          },
        });
      },
    });
    expect((await gateway.fetchIssue('9'))?.identifier).toBe('ENG-9');
    mode = 'archived';
    expect(await gateway.fetchIssue('9')).toBeNull();
    mode = 'missing';
    expect(await gateway.fetchIssue('9')).toBeNull();
  });

  test('fetchIssue rethrows errors that are not not-found', async () => {
    const { gateway } = gatewayWith({
      Issue: () => jsonResponse({}, { status: 401 }),
    });
    expect(await caught(gateway.fetchIssue('1'))).toMatchObject({
      kind: 'unauthorized',
    });
  });

  test('fetchIssueRelations merges both sides, pages, and keeps "blocks" only', async () => {
    const { gateway, calls } = gatewayWith({
      IssueRelationsForIssue: () =>
        dataResponse({
          issue: {
            id: 'a',
            relations: connection(
              [
                relationNode('r1', 'blocks', 'a', 'b'),
                relationNode('r2', 'related', 'a', 'c'),
              ],
              'rc1'
            ),
            inverseRelations: connection([
              relationNode('r3', 'blocks', 'z', 'a'),
            ]),
          },
        }),
      IssueRelationsPage: (variables) => {
        expect(variables).toEqual({ id: 'a', after: 'rc1' });
        return dataResponse({
          issue: {
            id: 'a',
            relations: connection([relationNode('r4', 'blocks', 'a', 'd')]),
          },
        });
      },
    });
    expect(await gateway.fetchIssueRelations('a')).toEqual([
      { id: 'r1', blockerId: 'a', blockedId: 'b' },
      { id: 'r4', blockerId: 'a', blockedId: 'd' },
      { id: 'r3', blockerId: 'z', blockedId: 'a' },
    ]);
    expect(calls.map((c) => c.operation)).toEqual([
      'IssueRelationsForIssue',
      'IssueRelationsPage',
    ]);
  });

  test('fetchIssueRelations refuses a nested page that has no cursor', async () => {
    // The engine replaces every relation touching the issue with this list,
    // so a cut-off list would delete relations.
    const { gateway, calls } = gatewayWith({
      IssueRelationsForIssue: () =>
        dataResponse({
          issue: {
            id: 'a',
            relations: connection([relationNode('r1', 'blocks', 'a', 'b')]),
            inverseRelations: {
              nodes: [relationNode('r2', 'blocks', 'z', 'a')],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        }),
    });
    expect(await caught(gateway.fetchIssueRelations('a'))).toMatchObject({
      kind: 'graphql',
    });
    expect(calls.map((c) => c.operation)).toEqual(['IssueRelationsForIssue']);
  });

  test('fetchProject refuses a milestone list longer than the page cap', async () => {
    let page = 0;
    const { gateway, calls } = gatewayWith({
      Project: () =>
        dataResponse({
          project: {
            ...projectNode('proj-1'),
            archivedAt: null,
            projectMilestones: connection([milestoneNode('ms-0')], 'm0'),
          },
        }),
      ProjectMilestonesPage: () => {
        page += 1;
        return dataResponse({
          project: {
            id: 'proj-1',
            projectMilestones: connection(
              [milestoneNode(`ms-${page}`)],
              `m${page}`
            ),
          },
        });
      },
    });
    expect(await caught(gateway.fetchProject('proj-1'))).toMatchObject({
      kind: 'graphql',
    });
    // Bounded: it stops at the cap instead of paging forever.
    const pages = calls.filter((c) => c.operation === 'ProjectMilestonesPage');
    expect(pages.length).toBe(100);
  });

  test('fetchProject returns the project with every page of milestones', async () => {
    const { gateway } = gatewayWith({
      Project: () =>
        dataResponse({
          project: {
            ...projectNode('proj-1'),
            archivedAt: null,
            projectMilestones: connection([milestoneNode('ms-1')], 'm1'),
          },
        }),
      ProjectMilestonesPage: (variables) => {
        expect(variables).toEqual({ id: 'proj-1', after: 'm1' });
        return dataResponse({
          project: {
            id: 'proj-1',
            projectMilestones: connection([milestoneNode('ms-2')]),
          },
        });
      },
    });
    const result = await gateway.fetchProject('proj-1');
    expect(result?.project.id).toBe('proj-1');
    expect(result?.milestones.map((m) => m.id)).toEqual(['ms-1', 'ms-2']);
  });

  test('fetchMilestone, fetchUser, fetchInitiative return null when missing', async () => {
    const { gateway } = gatewayWith({
      ProjectMilestone: notFound,
      User: notFound,
      Initiative: notFound,
    });
    expect(await gateway.fetchMilestone('x')).toBeNull();
    expect(await gateway.fetchUser('x')).toBeNull();
    expect(await gateway.fetchInitiative('x')).toBeNull();
  });

  test('fetchMilestone and fetchInitiative map present entities', async () => {
    const { gateway } = gatewayWith({
      ProjectMilestone: () =>
        dataResponse({
          projectMilestone: { ...milestoneNode('ms-1'), archivedAt: null },
        }),
      Initiative: () =>
        dataResponse({
          initiative: {
            id: 'i',
            name: 'I',
            sortOrder: 1,
            priority: 1,
            targetDate: '2026-12-31',
            archivedAt: null,
          },
        }),
      User: () => dataResponse({ user: userNode('u', { active: false }) }),
    });
    expect((await gateway.fetchMilestone('ms-1'))?.targetDate).toBe(
      '2026-11-01'
    );
    expect((await gateway.fetchInitiative('i'))?.targetDate).toBe('2026-12-31');
    expect((await gateway.fetchUser('u'))?.active).toBe(false);
  });
});

describe('mutations', () => {
  test('updateIssue sends only the provided fields', async () => {
    const { gateway, calls } = gatewayWith({
      IssueUpdate: (variables) =>
        dataResponse({
          issueUpdate: {
            success: true,
            issue: issueNode(String(variables['id']), {
              assignee: { id: 'u1' },
            }),
          },
        }),
    });
    const issue = await gateway.updateIssue('5', { assigneeId: 'u1' });
    expect(issue.assigneeId).toBe('u1');
    expect(calls[0]?.variables).toEqual({
      id: '5',
      input: { assigneeId: 'u1' },
    });

    await gateway.updateIssue('5', { assigneeId: 'u1', stateId: 's-todo' });
    expect(calls[1]?.variables).toEqual({
      id: '5',
      input: { assigneeId: 'u1', stateId: 's-todo' },
    });

    expect(await caught(gateway.updateIssue('5', {}))).toMatchObject({
      kind: 'invalid_input',
    });
    expect(calls).toHaveLength(2);
  });

  test('a state change sets lastStateChangeAt to the update time', async () => {
    const { gateway } = gatewayWith({
      IssueUpdate: () =>
        dataResponse({
          issueUpdate: {
            success: true,
            issue: issueNode('5', { updatedAt: '2026-10-21T09:30:00.000Z' }),
          },
        }),
    });
    expect(
      (await gateway.updateIssue('5', { stateId: 's' })).lastStateChangeAt
    ).toBe('2026-10-21T09:30:00.000Z');
    expect(
      (await gateway.updateIssue('5', { assigneeId: 'u' })).lastStateChangeAt
    ).toBe('2026-10-01T10:00:00.000Z');
  });

  test('success=false on any mutation throws LinearApiError', async () => {
    const { gateway } = gatewayWith({
      IssueUpdate: () =>
        dataResponse({ issueUpdate: { success: false, issue: null } }),
      CommentCreate: () =>
        dataResponse({
          commentCreate: { success: false, comment: { id: 'c' } },
        }),
      ProjectMilestoneUpdate: () =>
        dataResponse({
          projectMilestoneUpdate: {
            success: false,
            projectMilestone: milestoneNode('m'),
          },
        }),
      ProjectUpdate: () =>
        dataResponse({ projectUpdate: { success: false, project: null } }),
    });
    for (const run of [
      () => gateway.updateIssue('1', { assigneeId: 'u' }),
      () => gateway.createComment('1', 'hello'),
      () => gateway.updateMilestoneTargetDate('m', '2026-11-01'),
      () => gateway.updateProjectLead('p', 'u'),
    ]) {
      const error = await run().then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(LinearApiError);
      expect((error as LinearApiError).message).toContain('success=false');
    }
  });

  test('createComment, milestone date and project lead send the documented inputs', async () => {
    const { gateway, calls } = gatewayWith({
      CommentCreate: () =>
        dataResponse({
          commentCreate: { success: true, comment: { id: 'comment-1' } },
        }),
      ProjectMilestoneUpdate: (variables) =>
        dataResponse({
          projectMilestoneUpdate: {
            success: true,
            projectMilestone: milestoneNode('m', {
              targetDate: (variables['input'] as { targetDate: string | null })
                .targetDate,
            }),
          },
        }),
      ProjectUpdate: () =>
        dataResponse({
          projectUpdate: {
            success: true,
            project: projectNode('p', { lead: null }),
          },
        }),
    });
    expect(await gateway.createComment('1', 'Assigned by Planner')).toEqual({
      id: 'comment-1',
    });
    expect(
      (await gateway.updateMilestoneTargetDate('m', '2026-12-01')).targetDate
    ).toBe('2026-12-01');
    expect(
      (await gateway.updateMilestoneTargetDate('m', null)).targetDate
    ).toBeNull();
    expect((await gateway.updateProjectLead('p', null)).leadId).toBeNull();
    expect(calls.map((c) => c.variables)).toEqual([
      { input: { issueId: '1', body: 'Assigned by Planner' } },
      { id: 'm', input: { targetDate: '2026-12-01' } },
      { id: 'm', input: { targetDate: null } },
      { id: 'p', input: { leadId: null } },
    ]);
    expect(
      await caught(gateway.updateMilestoneTargetDate('m', '12/01/2026'))
    ).toMatchObject({ kind: 'invalid_input' });
  });

  test('createComment is not retried after a server error', async () => {
    let count = 0;
    const { gateway } = gatewayWith({
      CommentCreate: () => {
        count += 1;
        return new Response('', { status: 500 });
      },
    });
    expect(await caught(gateway.createComment('1', 'x'))).toMatchObject({
      kind: 'server',
    });
    expect(count).toBe(1);
  });
});
