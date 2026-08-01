import type {
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearWorkflowState,
} from '@dispatch/core';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

// Ceiling on a single page walk. At 50 issues a page this is 2,000 issues, well
// past a normal poll window; hitting it is reported rather than silently ignored.
const MAX_PAGES = 40;

/** Why a call failed, so callers can back off on `rate-limit` instead of retrying blindly. */
export type LinearErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'graphql'
  | 'http';

export interface LinearFailure {
  ok: false;
  kind: LinearErrorKind;
  error: string;
  /** Milliseconds to wait before the next attempt; only set on `rate-limit`. */
  retryAfterMs?: number;
}

export type LinearResult<T> = { ok: true; data: T } | LinearFailure;

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** A page walk's result. `truncated` means the page cap stopped the walk before the last page. */
export interface LinearIssuePage {
  issues: LinearIssue[];
  truncated: boolean;
}

/** The surface the sync engine talks to. Implemented for real below, faked in tests. */
export interface LinearClient {
  viewer(): Promise<LinearResult<LinearViewer>>;
  teams(): Promise<LinearResult<LinearTeam[]>>;
  workflowStates(teamId: string): Promise<LinearResult<LinearWorkflowState[]>>;
  labels(teamId: string): Promise<LinearResult<LinearLabel[]>>;
  issuesUpdatedSince(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearIssuePage>>;
  createIssue(input: LinearIssueInput): Promise<LinearResult<LinearIssue>>;
  updateIssue(
    id: string,
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>>;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  createdAt
  updatedAt
  archivedAt
  state { id name type }
  labels { nodes { id name color } }
  team { id key }
`;

const VIEWER_QUERY = `query Viewer { viewer { id name email } }`;

const TEAMS_QUERY = `query Teams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATES_QUERY = `query WorkflowStates($teamId: String!) {
  team(id: $teamId) { states(first: 100) { nodes { id name type } } }
}`;

const LABELS_QUERY = `query IssueLabels($teamId: String!) {
  team(id: $teamId) { labels(first: 250) { nodes { id name color } } }
}`;

const ISSUES_QUERY = `query IssuesUpdatedSince($teamId: String!, $since: DateTimeOrDuration, $after: String) {
  issues(
    filter: { team: { id: { eq: $teamId } }, updatedAt: { gt: $since } }
    first: 50
    after: $after
    orderBy: updatedAt
    includeArchived: true
  ) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUES_QUERY_ALL = `query IssuesAll($teamId: String!, $after: String) {
  issues(
    filter: { team: { id: { eq: $teamId } } }
    first: 50
    after: $after
    orderBy: updatedAt
    includeArchived: true
  ) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; type?: string };
}

interface GraphQLBody<T> {
  data?: T;
  errors?: GraphQLError[];
}

interface Connection<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  state: LinearWorkflowState | null;
  labels?: { nodes: LinearLabel[] };
  team: { id: string; key: string } | null;
}

function toIssue(node: IssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: typeof node.priority === 'number' ? node.priority : 0,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt ?? null,
    state: node.state ?? null,
    labels: node.labels?.nodes ?? [],
    team: node.team ?? null,
  };
}

// Throttling arrives as HTTP 400 carrying a RATELIMITED code inside the GraphQL
// errors array, not as a 429 — a status-code-only check would mis-bucket it.
function isRateLimited(errors: GraphQLError[]): boolean {
  return errors.some(
    (e) =>
      e.extensions?.code === 'RATELIMITED' ||
      e.extensions?.type === 'ratelimited' ||
      (e.message ?? '').toUpperCase().includes('RATELIMIT')
  );
}

function isAuthError(status: number, errors: GraphQLError[]): boolean {
  if (status === 401 || status === 403) return true;
  return errors.some(
    (e) =>
      e.extensions?.code === 'AUTHENTICATION_ERROR' ||
      (e.message ?? '').toLowerCase().includes('authentication')
  );
}

// How long to wait after a throttle: the reset headers carry a UTC epoch in
// milliseconds, and a missing/absurd value falls back to a flat minute.
function backoffFromHeaders(headers: Headers): number {
  const raw =
    headers.get('x-ratelimit-endpoint-requests-reset') ??
    headers.get('x-ratelimit-requests-reset');
  const resetAt = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(resetAt)) return 60_000;
  const wait = resetAt - Date.now();
  return wait > 0 && wait < 3_600_000 ? wait : 60_000;
}

export interface HttpLinearClientOptions {
  /** Overridden in tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  url?: string;
}

/** Hand-written GraphQL client for Linear. Every method resolves to a discriminated result
 *  rather than throwing, so a failure in one direction never aborts the other. */
export class HttpLinearClient implements LinearClient {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(
    private readonly apiKey: string,
    options: HttpLinearClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? LINEAR_API_URL;
  }

  // Strips the key out of anything that would be surfaced to a caller or a log, so an
  // upstream error message can never carry the credential with it.
  private redact(message: string): string {
    return this.apiKey === ''
      ? message
      : message.split(this.apiKey).join('[redacted]');
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<LinearResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          // A personal API key goes bare — `Bearer` is for OAuth tokens only.
          authorization: this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      return {
        ok: false,
        kind: 'network',
        error: this.redact(`linear request failed: ${(err as Error).message}`),
      };
    }

    let body: GraphQLBody<T> | null = null;
    try {
      body = (await res.json()) as GraphQLBody<T>;
    } catch {
      body = null;
    }
    const errors = body?.errors ?? [];

    if (errors.length > 0 || !res.ok) {
      if (isRateLimited(errors)) {
        return {
          ok: false,
          kind: 'rate-limit',
          error: 'linear rate limit reached',
          retryAfterMs: backoffFromHeaders(res.headers),
        };
      }
      const joined = errors.map((e) => e.message ?? 'unknown error').join('; ');
      const message = joined === '' ? `linear responded ${res.status}` : joined;
      return {
        ok: false,
        kind: isAuthError(res.status, errors)
          ? 'auth'
          : errors.length > 0
            ? 'graphql'
            : 'http',
        error: this.redact(message),
      };
    }

    if (body?.data === undefined) {
      return { ok: false, kind: 'graphql', error: 'linear returned no data' };
    }
    return { ok: true, data: body.data };
  }

  // Walks Relay-style `first`/`after` pages until `hasNextPage` is false, stopping short if the
  // API ever keeps claiming another page — an unbounded loop here would burn the hourly budget.
  private async paginate<N>(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: unknown) => Connection<N> | null | undefined
  ): Promise<LinearResult<{ nodes: N[]; truncated: boolean }>> {
    const nodes: N[] = [];
    let after: string | null = null;
    let truncated = false;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      const result = await this.request<unknown>(query, {
        ...variables,
        after,
      });
      if (!result.ok) return result;
      const connection = pick(result.data);
      if (connection === null || connection === undefined) break;
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (after === null) break;
    }
    return { ok: true, data: { nodes, truncated } };
  }

  async viewer(): Promise<LinearResult<LinearViewer>> {
    const result = await this.request<{ viewer: LinearViewer }>(VIEWER_QUERY);
    return result.ok ? { ok: true, data: result.data.viewer } : result;
  }

  async teams(): Promise<LinearResult<LinearTeam[]>> {
    const result = await this.paginate<LinearTeam>(
      TEAMS_QUERY,
      {},
      (data) => (data as { teams?: Connection<LinearTeam> }).teams
    );
    return result.ok ? { ok: true, data: result.data.nodes } : result;
  }

  async workflowStates(
    teamId: string
  ): Promise<LinearResult<LinearWorkflowState[]>> {
    const result = await this.request<{
      team: { states: { nodes: LinearWorkflowState[] } } | null;
    }>(STATES_QUERY, { teamId });
    if (!result.ok) return result;
    return { ok: true, data: result.data.team?.states.nodes ?? [] };
  }

  async labels(teamId: string): Promise<LinearResult<LinearLabel[]>> {
    const result = await this.request<{
      team: { labels: { nodes: LinearLabel[] } } | null;
    }>(LABELS_QUERY, { teamId });
    if (!result.ok) return result;
    return { ok: true, data: result.data.team?.labels.nodes ?? [] };
  }

  async issuesUpdatedSince(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearIssuePage>> {
    const result = await this.paginate<IssueNode>(
      since === null ? ISSUES_QUERY_ALL : ISSUES_QUERY,
      since === null ? { teamId } : { teamId, since },
      (data) => (data as { issues?: Connection<IssueNode> }).issues
    );
    return result.ok
      ? {
          ok: true,
          data: {
            issues: result.data.nodes.map(toIssue),
            truncated: result.data.truncated,
          },
        }
      : result;
  }

  async createIssue(
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    const result = await this.request<{
      issueCreate: { success: boolean; issue: IssueNode | null };
    }>(CREATE_MUTATION, { input });
    if (!result.ok) return result;
    const { success, issue } = result.data.issueCreate;
    if (!success || issue === null) {
      return {
        ok: false,
        kind: 'graphql',
        error: 'linear rejected the create',
      };
    }
    return { ok: true, data: toIssue(issue) };
  }

  async updateIssue(
    id: string,
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    const result = await this.request<{
      issueUpdate: { success: boolean; issue: IssueNode | null };
    }>(UPDATE_MUTATION, { id, input });
    if (!result.ok) return result;
    const { success, issue } = result.data.issueUpdate;
    if (!success || issue === null) {
      return {
        ok: false,
        kind: 'graphql',
        error: 'linear rejected the update',
      };
    }
    return { ok: true, data: toIssue(issue) };
  }
}
