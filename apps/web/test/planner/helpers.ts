// Fake fetch implementations for the Linear tests. Nothing here talks to the
// network: each fake records the requests it receives and answers from a
// handler keyed by GraphQL operation name (or a scripted response list).

import type { FetchLike } from '../../src/planner/linear/client.js';
import { operationName } from '../../src/planner/linear/client.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Raw request body. */
  body: string;
  /** Parsed GraphQL body, when the request was JSON. */
  operation: string;
  query: string;
  variables: Record<string, unknown>;
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** `{ data }` with HTTP 200. */
export function dataResponse(data: unknown): Response {
  return jsonResponse({ data });
}

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function record(url: string, init: RequestInit): RecordedCall {
  const body = typeof init.body === 'string' ? init.body : '';
  let query = '';
  let variables: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    query = parsed.query ?? '';
    variables = parsed.variables ?? {};
  } catch {
    // Form-encoded (OAuth) bodies are not JSON.
  }
  return {
    url,
    method: init.method ?? 'GET',
    headers: headersOf(init),
    body,
    operation: query === '' ? '' : operationName(query),
    query,
    variables,
  };
}

export type GraphqlHandler = (
  variables: Record<string, unknown>,
  call: RecordedCall
) => Response | Promise<Response>;

/**
 * A fetch that routes GraphQL requests by operation name. Unknown
 * operations fail the test loudly with a 500-free error body.
 */
export function graphqlFetch(handlers: Record<string, GraphqlHandler>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = record(url, init);
    calls.push(call);
    const handler = handlers[call.operation];
    if (handler === undefined) {
      return Promise.reject(
        new Error(`No fake handler for operation ${call.operation}`)
      );
    }
    return Promise.resolve(handler(call.variables, call));
  };
  return { fetch, calls };
}

/** A fetch that answers with the given responses in order. */
export function scriptedFetch(
  responses: (Response | Error | (() => Response))[]
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push(record(url, init));
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      return Promise.reject(new Error('scriptedFetch ran out of responses'));
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };
  return { fetch, calls };
}

/** A paged connection body. */
export function connection(
  nodes: unknown[],
  endCursor: string | null = null
): {
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

/** A recording logger that keeps every call for assertions. */
export function recordingLogger(): {
  logger: {
    debug: (m: string, f?: Record<string, unknown>) => void;
    info: (m: string, f?: Record<string, unknown>) => void;
    warn: (m: string, f?: Record<string, unknown>) => void;
    error: (m: string, f?: Record<string, unknown>) => void;
  };
  lines: { level: string; message: string; fields: Record<string, unknown> }[];
} {
  const lines: {
    level: string;
    message: string;
    fields: Record<string, unknown>;
  }[] = [];
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, message, fields });
    };
  return {
    logger: {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    },
    lines,
  };
}

// --- Linear node builders (shapes as queries.ts selects them) --------------

export function userNode(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `Name ${id}`,
    displayName: id,
    email: `${id}@example.com`,
    active: true,
    avatarUrl: null,
    app: false,
    guest: false,
    ...overrides,
  };
}

export function issueNode(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    url: `https://linear.app/acme/issue/ENG-${id}`,
    priority: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    team: { id: 'team-1' },
    project: { id: 'proj-1' },
    projectMilestone: { id: 'ms-1' },
    assignee: null,
    state: { id: 'state-1' },
    ...overrides,
  };
}

export function projectNode(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `Project ${id}`,
    url: `https://linear.app/acme/project/${id}`,
    priority: 2,
    sortOrder: 1.5,
    startDate: '2026-10-01',
    targetDate: null,
    lead: { id: 'user-1' },
    status: { type: 'started', name: 'In Progress' },
    initiatives: { nodes: [{ id: 'init-1' }] },
    teams: { nodes: [{ id: 'team-1' }] },
    ...overrides,
  };
}

export function milestoneNode(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `Milestone ${id}`,
    description: null,
    targetDate: '2026-11-01',
    sortOrder: 1,
    project: { id: 'proj-1' },
    ...overrides,
  };
}

export function relationNode(
  id: string,
  type: string,
  issue: string,
  relatedIssue: string
): Record<string, unknown> {
  return { id, type, issue: { id: issue }, relatedIssue: { id: relatedIssue } };
}

export const noSleep = (_ms: number): Promise<void> => Promise.resolve();

/** The error a promise rejects with (fails the test if it resolves). */
export async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

// --- a fake workspace over graphqlFetch ------------------------------------

/**
 * Serves `pages` of a root connection keyed by the incoming `after` cursor:
 * page i is returned for cursor `c{i}` (null for the first page).
 */
export function pagedHandler(
  field: string,
  pages: unknown[][]
): GraphqlHandler {
  return (variables) => {
    const after = variables['after'];
    const index = typeof after === 'string' ? Number(after.slice(1)) : 0;
    const nodes = pages[index] ?? [];
    const next = index + 1 < pages.length ? `c${index + 1}` : null;
    return dataResponse({ [field]: connection(nodes, next) });
  };
}

/** The root connections fetchWorkspace pages, by operation name. */
const WORKSPACE_CONNECTIONS: Readonly<Record<string, string>> = {
  Users: 'users',
  Teams: 'teams',
  WorkflowStates: 'workflowStates',
  Initiatives: 'initiatives',
  Projects: 'projects',
  ProjectMilestones: 'projectMilestones',
  ProjectIssues: 'issues',
  OpenIssuesWithoutProject: 'issues',
  IssueRelations: 'issueRelations',
  TeamMemberships: 'teamMemberships',
};

/** What workspaceHandlers serves: the identity, and pages per connection. */
export interface FakeWorkspace {
  /** Answers `Identity`; defaults to user-1 in org-1 (Acme). */
  identity?: {
    viewer: Record<string, unknown>;
    organization: { id: string; name: string; urlKey: string };
  };
  /** Pages of nodes per operation name (WORKSPACE_CONNECTIONS); default one empty page. */
  pages?: Partial<Record<keyof typeof WORKSPACE_CONNECTIONS, unknown[][]>>;
}

/**
 * The handler set behind fetchWorkspace (Identity and every root
 * connection), for graphqlFetch. The gateway tests and the e2e fake Linear
 * server (apps/planner/e2e/fake-linear-server.ts) share it.
 */
export function workspaceHandlers(
  workspace: FakeWorkspace = {}
): Record<string, GraphqlHandler> {
  const identity = workspace.identity ?? {
    viewer: userNode('user-1'),
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  };
  const handlers: Record<string, GraphqlHandler> = {
    Identity: () => dataResponse(identity),
  };
  for (const [operation, field] of Object.entries(WORKSPACE_CONNECTIONS)) {
    handlers[operation] = pagedHandler(
      field,
      workspace.pages?.[operation] ?? [[]]
    );
  }
  return handlers;
}
