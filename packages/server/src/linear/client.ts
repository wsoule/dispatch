import type {
  LinearAttachment,
  LinearComment,
  LinearInitiative,
  LinearInitiativeInput,
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearMilestoneInput,
  LinearProject,
  LinearProjectInput,
  LinearProjectMilestone,
  LinearProjectStatus,
  LinearRelation,
  LinearTruncatedField,
  LinearUser,
  LinearWorkflowState,
  TaskCycle,
} from '@dispatch/core';

import type { LinearDocument } from '../docs/linear.js';
import * as Q from './queries.js';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

// Ceiling on one page walk, in nodes: 10,000 issues plus headroom. Hitting it
// is reported (`truncated`) rather than silently dropping the rest.
const MAX_WALK_NODES = 12_000;

/** Why a call failed, so callers can back off on `rate-limit` instead of retrying blindly. */
type LinearErrorKind = 'auth' | 'rate-limit' | 'network' | 'graphql' | 'http';

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

/** A chip's display fields plus the remote version, without paying for a whole issue. */
export interface LinearIssueRef {
  id: string;
  identifier: string;
  url: string;
  updatedAt: string;
}

/** A page walk's result. `truncated` means the node cap stopped the walk early. */
export interface LinearPage<T> {
  nodes: T[];
  truncated: boolean;
}

export interface LinearIssuePage {
  issues: LinearIssue[];
  truncated: boolean;
}

/** Everything about the linked team a pass needs besides its issues. */
export interface LinearWorkspace {
  viewer: LinearUser;
  team: LinearTeam;
  states: LinearWorkflowState[];
  members: LinearUser[];
  projectStatuses: LinearProjectStatus[];
}

/** Which entity kinds changed since a cursor, from one cheap request. */
export interface LinearProbe {
  issues: boolean;
  comments: boolean;
  projects: boolean;
  milestones: boolean;
  initiatives: boolean;
  documents: boolean;
}

export interface LinearWebhookInput {
  url: string;
  teamId: string;
  secret: string;
  label: string;
  resourceTypes: string[];
}

/** The surface the sync engine talks to. Implemented for real below, faked in tests. */
export interface LinearClient {
  viewer(): Promise<LinearResult<LinearViewer>>;
  teams(): Promise<LinearResult<LinearTeam[]>>;
  workflowStates(teamId: string): Promise<LinearResult<LinearWorkflowState[]>>;
  workspace(teamId: string): Promise<LinearResult<LinearWorkspace>>;
  /** The team's labels plus workspace labels, group labels excluded. */
  labels(teamId: string): Promise<LinearResult<LinearLabel[]>>;
  cycles(teamId: string): Promise<LinearResult<TaskCycle[]>>;
  users(ids: string[]): Promise<LinearResult<LinearUser[]>>;
  /** Documents are asked about after their own cursor, `documentsSince`. */
  probe(
    teamId: string,
    since: string,
    documentsSince?: string
  ): Promise<LinearResult<LinearProbe>>;
  /** `onPage` hears the running count after each page, for progress. */
  issuesUpdatedSince(
    teamId: string,
    since: string | null,
    onPage?: (fetched: number) => void
  ): Promise<LinearResult<LinearIssuePage>>;
  issuesByIds(ids: string[]): Promise<LinearResult<LinearIssue[]>>;
  /** Just the display fields, for filling in chips on issues that may never change again. */
  issueLinks(teamId: string): Promise<LinearResult<LinearIssueRef[]>>;
  comments(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearComment>>>;
  commentsByIds(ids: string[]): Promise<LinearResult<LinearComment[]>>;
  projects(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearProject>>>;
  projectMilestones(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearProjectMilestone>>>;
  initiatives(
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearInitiative>>>;
  /** Documents of the team's projects, issues and the team itself. */
  documents(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearDocument>>>;
  document(id: string): Promise<LinearResult<LinearDocument>>;
  /** Replaces the document's markdown; Linear offers no precondition. */
  updateDocument(
    id: string,
    content: string
  ): Promise<LinearResult<LinearDocument>>;
  createDocument(input: {
    title: string;
    content: string;
    projectId?: string;
    issueId?: string;
  }): Promise<LinearResult<LinearDocument>>;
  documentContentHistory(
    id: string
  ): Promise<LinearResult<LinearContentHistoryEntry[]>>;
  createIssue(input: LinearIssueInput): Promise<LinearResult<LinearIssue>>;
  updateIssue(
    id: string,
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>>;
  archiveIssue(id: string): Promise<LinearResult<LinearIssue>>;
  unarchiveIssue(id: string): Promise<LinearResult<LinearIssue>>;
  createRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: string;
  }): Promise<LinearResult<LinearRelation>>;
  deleteRelation(id: string): Promise<LinearResult<null>>;
  createLabel(input: {
    name: string;
    teamId: string;
    color?: string;
  }): Promise<LinearResult<LinearLabel>>;
  /** Recolors a label (Linear requires every label to have a color). */
  updateLabel(
    id: string,
    input: { color: string }
  ): Promise<LinearResult<LinearLabel>>;
  linkAttachment(
    issueId: string,
    url: string,
    title: string
  ): Promise<LinearResult<LinearAttachment>>;
  deleteAttachment(id: string): Promise<LinearResult<null>>;
  createComment(input: {
    issueId: string;
    body: string;
    parentId?: string;
  }): Promise<LinearResult<LinearComment>>;
  updateComment(id: string, body: string): Promise<LinearResult<LinearComment>>;
  deleteComment(id: string): Promise<LinearResult<null>>;
  createProject(
    input: LinearProjectInput & { name: string; teamIds: string[] }
  ): Promise<LinearResult<LinearProject>>;
  updateProject(
    id: string,
    input: LinearProjectInput
  ): Promise<LinearResult<LinearProject>>;
  createMilestone(
    input: LinearMilestoneInput & { name: string; projectId: string }
  ): Promise<LinearResult<LinearProjectMilestone>>;
  updateMilestone(
    id: string,
    input: LinearMilestoneInput
  ): Promise<LinearResult<LinearProjectMilestone>>;
  createInitiative(
    input: LinearInitiativeInput & { name: string }
  ): Promise<LinearResult<LinearInitiative>>;
  updateInitiative(
    id: string,
    input: LinearInitiativeInput
  ): Promise<LinearResult<LinearInitiative>>;
  /** Adds a project to an initiative; the membership row's id. */
  linkProjectInitiative(
    projectId: string,
    initiativeId: string
  ): Promise<LinearResult<string>>;
  unlinkProjectInitiative(linkId: string): Promise<LinearResult<null>>;
  createWebhook(input: LinearWebhookInput): Promise<LinearResult<string>>;
  deleteWebhook(id: string): Promise<LinearResult<null>>;
}

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

interface Nested<N> {
  nodes: N[];
  pageInfo?: { hasNextPage: boolean };
}

type IdRef = { id: string } | null | undefined;

interface RelationNode {
  id: string;
  type: string;
  issue: { id: string };
  relatedIssue: { id: string };
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate?: number | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  dueDate?: string | null;
  state: LinearWorkflowState | null;
  team: { id: string; key: string } | null;
  assignee?: IdRef;
  creator?: IdRef;
  cycle?: TaskCycle | null;
  project?: IdRef;
  projectMilestone?: IdRef;
  parent?: IdRef;
  labels?: Nested<{ id: string; name: string }>;
  relations?: Nested<RelationNode>;
  inverseRelations?: Nested<RelationNode>;
  attachments?: Nested<LinearAttachment>;
  children?: Nested<{ id: string }>;
}

interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  user: IdRef;
  parent: IdRef;
  issue: IdRef;
}

interface ProjectNode {
  id: string;
  name: string;
  description: string | null;
  content: string | null;
  icon: string | null;
  color: string | null;
  startDate: string | null;
  targetDate: string | null;
  priority: number | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lead: IdRef;
  status: LinearProjectStatus | null;
  teams?: { nodes: { id: string }[] };
  initiativeToProjects?: { nodes: { id: string; initiative: IdRef }[] };
}

interface MilestoneNode {
  id: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  project: IdRef;
}

interface InitiativeNode {
  id: string;
  name: string;
  description: string | null;
  content: string | null;
  status: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  owner: IdRef;
  creator: IdRef;
}

interface LabelNode {
  id: string;
  name: string;
  color: string | null;
  isGroup?: boolean;
  team: IdRef;
  parent: { name: string } | null;
}

interface UserNode {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  active: boolean | null;
}

const idOf = (ref: IdRef): string | null => ref?.id ?? null;

function toRelation(node: RelationNode): LinearRelation {
  return {
    id: node.id,
    type: node.type,
    issueId: node.issue.id,
    relatedIssueId: node.relatedIssue.id,
  };
}

function toIssue(node: IssueNode): LinearIssue {
  const truncated: LinearTruncatedField[] = [];
  const more = (list: Nested<unknown> | undefined) =>
    list?.pageInfo?.hasNextPage === true;
  if (more(node.labels)) truncated.push('labels');
  if (more(node.relations) || more(node.inverseRelations)) {
    truncated.push('relations');
  }
  if (more(node.attachments)) truncated.push('attachments');
  if (more(node.children)) truncated.push('children');
  const relations = new Map<string, LinearRelation>();
  for (const r of [
    ...(node.relations?.nodes ?? []),
    ...(node.inverseRelations?.nodes ?? []),
  ]) {
    relations.set(r.id, toRelation(r));
  }
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: typeof node.priority === 'number' ? node.priority : 0,
    estimate: node.estimate ?? null,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt ?? null,
    dueDate: node.dueDate ?? null,
    state: node.state ?? null,
    labels: (node.labels?.nodes ?? []).map((l) => ({ id: l.id, name: l.name })),
    team: node.team ?? null,
    assigneeId: idOf(node.assignee),
    creatorId: idOf(node.creator),
    cycle:
      node.cycle === null || node.cycle === undefined
        ? null
        : {
            id: node.cycle.id,
            number: node.cycle.number,
            name: node.cycle.name ?? null,
            startsAt: node.cycle.startsAt,
            endsAt: node.cycle.endsAt,
          },
    projectId: idOf(node.project),
    projectMilestoneId: idOf(node.projectMilestone),
    parentId: idOf(node.parent),
    childIds: (node.children?.nodes ?? []).map((c) => c.id),
    relations: [...relations.values()],
    attachments: (node.attachments?.nodes ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      subtitle: a.subtitle ?? null,
      sourceType: a.sourceType ?? null,
    })),
    truncated,
  };
}

function toComment(node: CommentNode): LinearComment | null {
  const issueId = idOf(node.issue);
  if (issueId === null) return null;
  return {
    id: node.id,
    issueId,
    body: node.body,
    userId: idOf(node.user),
    parentId: idOf(node.parent),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt ?? null,
  };
}

interface DocumentNode {
  id: string;
  title: string;
  content?: string | null;
  updatedAt: string;
  updatedBy?: { id: string } | null;
  issue?: { id: string } | null;
  project?: { id: string } | null;
  initiative?: { id: string } | null;
  cycle?: { id: string } | null;
  release?: { id: string } | null;
  team?: { id: string } | null;
}

/** One `documentContentHistory` entry: when it snapshotted, and who edited. */
export interface LinearContentHistoryEntry {
  contentDataSnapshotAt: string;
  actorIds: string[];
}

// The most specific parent wins: an issue's document is the issue's.
const DOCUMENT_PARENTS = [
  'issue',
  'project',
  'initiative',
  'cycle',
  'release',
  'team',
] as const;

function toDocument(node: DocumentNode): LinearDocument {
  const kind = DOCUMENT_PARENTS.find((k) => (node[k]?.id ?? null) !== null);
  const parentId = kind === undefined ? null : (node[kind]?.id ?? null);
  return {
    id: node.id,
    title: node.title,
    content: node.content ?? '',
    updatedAt: node.updatedAt,
    updatedBy: node.updatedBy?.id ?? null,
    parent:
      kind === undefined || parentId === null ? null : { kind, id: parentId },
  };
}

function toProject(node: ProjectNode): LinearProject {
  return {
    id: node.id,
    name: node.name,
    summary: node.description ?? '',
    content: node.content ?? null,
    icon: node.icon ?? null,
    color: node.color ?? null,
    startDate: node.startDate ?? null,
    targetDate: node.targetDate ?? null,
    leadId: idOf(node.lead),
    status: node.status ?? null,
    priority: node.priority ?? 0,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt ?? null,
    teamIds: (node.teams?.nodes ?? []).map((t) => t.id),
    initiatives: (node.initiativeToProjects?.nodes ?? []).flatMap((link) => {
      const initiativeId = idOf(link.initiative);
      return initiativeId === null ? [] : [{ id: link.id, initiativeId }];
    }),
  };
}

function toMilestone(node: MilestoneNode): LinearProjectMilestone | null {
  const projectId = idOf(node.project);
  if (projectId === null) return null;
  return {
    id: node.id,
    name: node.name,
    description: node.description ?? null,
    targetDate: node.targetDate ?? null,
    sortOrder: node.sortOrder ?? 0,
    projectId,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt ?? null,
  };
}

function toInitiative(node: InitiativeNode): LinearInitiative {
  return {
    id: node.id,
    name: node.name,
    description: node.description ?? null,
    content: node.content ?? null,
    ownerId: idOf(node.owner),
    creatorId: idOf(node.creator),
    status: node.status ?? 'Planned',
    targetDate: node.targetDate ?? null,
    color: node.color ?? null,
    icon: node.icon ?? null,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt ?? null,
  };
}

function toLabel(node: LabelNode): LinearLabel {
  return {
    id: node.id,
    name: node.name,
    ...(node.color === null ? {} : { color: node.color }),
    group: node.parent?.name ?? null,
    teamId: idOf(node.team),
  };
}

function toUser(node: UserNode): LinearUser {
  return {
    id: node.id,
    name: node.name,
    displayName: node.displayName ?? node.name,
    email: node.email ?? null,
    avatarUrl: node.avatarUrl ?? null,
    active: node.active ?? true,
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
    headers.get('x-ratelimit-requests-reset') ??
    headers.get('x-ratelimit-complexity-reset');
  const resetAt = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(resetAt)) return 60_000;
  const wait = resetAt - Date.now();
  return wait > 0 && wait < 3_600_000 ? wait : 60_000;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function rejected(what: string): LinearFailure {
  return { ok: false, kind: 'graphql', error: `linear rejected the ${what}` };
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

  // Walks Relay-style `first`/`after` pages until `hasNextPage` is false, stopping short
  // once the node cap is reached — an unbounded loop here would burn the hourly budget.
  private async paginate<N>(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: unknown) => Connection<N> | null | undefined,
    onPage?: (fetched: number) => void
  ): Promise<LinearResult<LinearPage<N>>> {
    const nodes: N[] = [];
    let after: string | null = null;
    let truncated = false;
    for (;;) {
      if (nodes.length >= MAX_WALK_NODES) {
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
      onPage?.(nodes.length);
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (after === null) break;
    }
    return { ok: true, data: { nodes, truncated } };
  }

  // A root-field page walk mapped node by node, dropping nodes the mapper rejects.
  private async walk<N, T>(
    query: string,
    variables: Record<string, unknown>,
    key: string,
    map: (node: N) => T | null,
    onPage?: (fetched: number) => void
  ): Promise<LinearResult<LinearPage<T>>> {
    const result = await this.paginate<N>(
      query,
      variables,
      (data) => (data as Record<string, Connection<N> | undefined>)[key],
      onPage
    );
    if (!result.ok) return result;
    const nodes: T[] = [];
    for (const node of result.data.nodes) {
      const mapped = map(node);
      if (mapped !== null) nodes.push(mapped);
    }
    return { ok: true, data: { nodes, truncated: result.data.truncated } };
  }

  // Walks `ids` a page at a time through an `id: { in }` query.
  private async byIds<N, T>(
    query: string,
    ids: string[],
    size: number,
    key: string,
    map: (node: N) => T | null
  ): Promise<LinearResult<T[]>> {
    const out: T[] = [];
    for (const batch of chunk(ids, size)) {
      const result = await this.walk(query, { ids: batch }, key, map);
      if (!result.ok) return result;
      out.push(...result.data.nodes);
    }
    return { ok: true, data: out };
  }

  // One mutation whose payload carries `success` and the written entity under `entity`.
  private async mutate<N, T>(
    query: string,
    variables: Record<string, unknown>,
    field: string,
    entity: string,
    map: (node: N) => T | null,
    what: string
  ): Promise<LinearResult<T>> {
    const result = await this.request<
      Record<string, (Record<string, unknown> & { success: boolean }) | null>
    >(query, variables);
    if (!result.ok) return result;
    const payload = result.data[field];
    if (payload === null || payload === undefined || !payload.success) {
      return rejected(what);
    }
    const node = payload[entity] as N | null | undefined;
    const mapped = node === null || node === undefined ? null : map(node);
    return mapped === null ? rejected(what) : { ok: true, data: mapped };
  }

  // A mutation whose payload is only `{ success }`.
  private async run(
    query: string,
    variables: Record<string, unknown>,
    field: string,
    what: string
  ): Promise<LinearResult<null>> {
    const result = await this.request<
      Record<string, { success: boolean } | null>
    >(query, variables);
    if (!result.ok) return result;
    return result.data[field]?.success === true
      ? { ok: true, data: null }
      : rejected(what);
  }

  async viewer(): Promise<LinearResult<LinearViewer>> {
    const result = await this.request<{ viewer: UserNode }>(Q.VIEWER_QUERY);
    if (!result.ok) return result;
    const v = result.data.viewer;
    return { ok: true, data: { id: v.id, name: v.name, email: v.email ?? '' } };
  }

  async teams(): Promise<LinearResult<LinearTeam[]>> {
    const result = await this.walk<LinearTeam, LinearTeam>(
      Q.TEAMS_QUERY,
      {},
      'teams',
      (t) => t
    );
    return result.ok ? { ok: true, data: result.data.nodes } : result;
  }

  async workflowStates(
    teamId: string
  ): Promise<LinearResult<LinearWorkflowState[]>> {
    const result = await this.request<{
      team: { states: { nodes: LinearWorkflowState[] } } | null;
    }>(Q.STATES_QUERY, { teamId });
    if (!result.ok) return result;
    return { ok: true, data: result.data.team?.states.nodes ?? [] };
  }

  async workspace(teamId: string): Promise<LinearResult<LinearWorkspace>> {
    const result = await this.request<{
      viewer: UserNode;
      team: {
        id: string;
        key: string;
        name: string;
        states: { nodes: LinearWorkflowState[] };
        members: Nested<UserNode>;
      } | null;
      projectStatuses: { nodes: LinearProjectStatus[] } | null;
    }>(Q.WORKSPACE_QUERY, { teamId });
    if (!result.ok) return result;
    const { team } = result.data;
    if (team === null) {
      return { ok: false, kind: 'graphql', error: `unknown team: ${teamId}` };
    }
    return {
      ok: true,
      data: {
        viewer: toUser(result.data.viewer),
        team: { id: team.id, key: team.key, name: team.name },
        states: team.states.nodes,
        members: team.members.nodes.map(toUser),
        projectStatuses: result.data.projectStatuses?.nodes ?? [],
      },
    };
  }

  async labels(teamId: string): Promise<LinearResult<LinearLabel[]>> {
    const result = await this.walk<LabelNode, LinearLabel>(
      Q.LABELS_QUERY,
      {},
      'issueLabels',
      (node) => {
        const owner = idOf(node.team);
        if (node.isGroup === true) return null;
        return owner === null || owner === teamId ? toLabel(node) : null;
      }
    );
    return result.ok ? { ok: true, data: result.data.nodes } : result;
  }

  async cycles(teamId: string): Promise<LinearResult<TaskCycle[]>> {
    const result = await this.paginate<TaskCycle>(
      Q.CYCLES_QUERY,
      { teamId },
      (data) =>
        (data as { team?: { cycles?: Connection<TaskCycle> } }).team?.cycles
    );
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data.nodes.map((c) => ({
        id: c.id,
        number: c.number,
        name: c.name ?? null,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
      })),
    };
  }

  users(ids: string[]): Promise<LinearResult<LinearUser[]>> {
    return this.byIds(Q.USERS_QUERY, ids, 50, 'users', toUser);
  }

  async probe(
    teamId: string,
    since: string,
    documentsSince: string = since
  ): Promise<LinearResult<LinearProbe>> {
    type Hit = { nodes: unknown[] } | null | undefined;
    const result = await this.request<Record<string, Hit>>(Q.PROBE_QUERY, {
      teamId,
      since,
      documentsSince,
    });
    if (!result.ok) return result;
    const hit = (key: string) => (result.data[key]?.nodes.length ?? 0) > 0;
    return {
      ok: true,
      data: {
        issues: hit('issues'),
        comments: hit('comments'),
        projects: hit('projects'),
        milestones: hit('projectMilestones'),
        initiatives: hit('initiatives'),
        documents: hit('documents'),
      },
    };
  }

  async issuesUpdatedSince(
    teamId: string,
    since: string | null,
    onPage?: (fetched: number) => void
  ): Promise<LinearResult<LinearIssuePage>> {
    const result = await this.walk<IssueNode, LinearIssue>(
      since === null ? Q.ISSUES_QUERY_ALL : Q.ISSUES_QUERY,
      since === null ? { teamId } : { teamId, since },
      'issues',
      toIssue,
      onPage
    );
    return result.ok
      ? {
          ok: true,
          data: { issues: result.data.nodes, truncated: result.data.truncated },
        }
      : result;
  }

  issuesByIds(ids: string[]): Promise<LinearResult<LinearIssue[]>> {
    return this.byIds(
      Q.ISSUES_BY_ID_QUERY,
      ids,
      Q.ISSUE_PAGE,
      'issues',
      toIssue
    );
  }

  async issueLinks(teamId: string): Promise<LinearResult<LinearIssueRef[]>> {
    const result = await this.walk<LinearIssueRef, LinearIssueRef>(
      Q.ISSUE_LINKS_QUERY,
      { teamId },
      'issues',
      (r) => r
    );
    return result.ok ? { ok: true, data: result.data.nodes } : result;
  }

  comments(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearComment>>> {
    return this.walk(
      since === null ? Q.COMMENTS_QUERY_ALL : Q.COMMENTS_QUERY,
      since === null ? { teamId } : { teamId, since },
      'comments',
      toComment
    );
  }

  commentsByIds(ids: string[]): Promise<LinearResult<LinearComment[]>> {
    return this.byIds(
      Q.COMMENTS_BY_ID_QUERY,
      ids,
      Q.COMMENT_PAGE,
      'comments',
      toComment
    );
  }

  projects(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearProject>>> {
    return this.walk(
      since === null ? Q.PROJECTS_QUERY_ALL : Q.PROJECTS_QUERY,
      since === null ? { teamId } : { teamId, since },
      'projects',
      toProject
    );
  }

  projectMilestones(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearProjectMilestone>>> {
    return this.walk(
      since === null ? Q.MILESTONES_QUERY_ALL : Q.MILESTONES_QUERY,
      since === null ? { teamId } : { teamId, since },
      'projectMilestones',
      toMilestone
    );
  }

  initiatives(
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearInitiative>>> {
    return this.walk(
      since === null ? Q.INITIATIVES_QUERY_ALL : Q.INITIATIVES_QUERY,
      since === null ? {} : { since },
      'initiatives',
      toInitiative
    );
  }

  createIssue(input: LinearIssueInput): Promise<LinearResult<LinearIssue>> {
    return this.mutate(
      Q.ISSUE_CREATE,
      { input },
      'issueCreate',
      'issue',
      toIssue,
      'create'
    );
  }

  documents(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearDocument>>> {
    return this.walk(
      since === null ? Q.DOCUMENTS_QUERY_ALL : Q.DOCUMENTS_QUERY,
      since === null ? { teamId } : { teamId, since },
      'documents',
      toDocument
    );
  }

  async document(id: string): Promise<LinearResult<LinearDocument>> {
    const result = await this.request<{ document: DocumentNode | null }>(
      Q.DOCUMENT_QUERY,
      { id }
    );
    if (!result.ok) return result;
    const doc = result.data.document;
    return doc === null
      ? { ok: false, kind: 'graphql', error: `no Linear document ${id}` }
      : { ok: true, data: toDocument(doc) };
  }

  updateDocument(
    id: string,
    content: string
  ): Promise<LinearResult<LinearDocument>> {
    return this.mutate(
      Q.DOCUMENT_UPDATE,
      { id, input: { content } },
      'documentUpdate',
      'document',
      toDocument,
      'update document'
    );
  }

  createDocument(input: {
    title: string;
    content: string;
    projectId?: string;
    issueId?: string;
  }): Promise<LinearResult<LinearDocument>> {
    return this.mutate(
      Q.DOCUMENT_CREATE,
      { input },
      'documentCreate',
      'document',
      toDocument,
      'create document'
    );
  }

  // History is keyed by the document's content id, read first.
  async documentContentHistory(
    id: string
  ): Promise<LinearResult<LinearContentHistoryEntry[]>> {
    const doc = await this.request<{
      document: { documentContentId?: string | null } | null;
    }>(Q.DOCUMENT_QUERY, { id });
    if (!doc.ok) return doc;
    const contentId = doc.data.document?.documentContentId ?? null;
    if (contentId === null) return { ok: true, data: [] };
    const result = await this.request<{
      documentContentHistory: {
        history: { contentDataSnapshotAt: string; actorIds: string[] | null }[];
      } | null;
    }>(Q.DOCUMENT_HISTORY, { id: contentId });
    if (!result.ok) return result;
    return {
      ok: true,
      data: (result.data.documentContentHistory?.history ?? []).map((h) => ({
        contentDataSnapshotAt: h.contentDataSnapshotAt,
        actorIds: h.actorIds ?? [],
      })),
    };
  }

  updateIssue(
    id: string,
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    return this.mutate(
      Q.ISSUE_UPDATE,
      { id, input },
      'issueUpdate',
      'issue',
      toIssue,
      'update'
    );
  }

  archiveIssue(id: string): Promise<LinearResult<LinearIssue>> {
    return this.mutate(
      Q.ISSUE_ARCHIVE,
      { id },
      'issueArchive',
      'entity',
      toIssue,
      'archive'
    );
  }

  unarchiveIssue(id: string): Promise<LinearResult<LinearIssue>> {
    return this.mutate(
      Q.ISSUE_UNARCHIVE,
      { id },
      'issueUnarchive',
      'entity',
      toIssue,
      'unarchive'
    );
  }

  createRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: string;
  }): Promise<LinearResult<LinearRelation>> {
    return this.mutate(
      Q.RELATION_CREATE,
      { input },
      'issueRelationCreate',
      'issueRelation',
      toRelation,
      'relation'
    );
  }

  deleteRelation(id: string): Promise<LinearResult<null>> {
    return this.run(
      Q.RELATION_DELETE,
      { id },
      'issueRelationDelete',
      'relation delete'
    );
  }

  createLabel(input: {
    name: string;
    teamId: string;
    color?: string;
  }): Promise<LinearResult<LinearLabel>> {
    return this.mutate(
      Q.LABEL_CREATE,
      { input },
      'issueLabelCreate',
      'issueLabel',
      toLabel,
      'label'
    );
  }

  updateLabel(
    id: string,
    input: { color: string }
  ): Promise<LinearResult<LinearLabel>> {
    return this.mutate(
      Q.LABEL_UPDATE,
      { id, input },
      'issueLabelUpdate',
      'issueLabel',
      toLabel,
      'label update'
    );
  }

  linkAttachment(
    issueId: string,
    url: string,
    title: string
  ): Promise<LinearResult<LinearAttachment>> {
    return this.mutate(
      Q.ATTACHMENT_LINK,
      { issueId, url, title },
      'attachmentLinkURL',
      'attachment',
      (a: LinearAttachment) => ({
        id: a.id,
        title: a.title,
        url: a.url,
        subtitle: a.subtitle ?? null,
        sourceType: a.sourceType ?? null,
      }),
      'attachment'
    );
  }

  deleteAttachment(id: string): Promise<LinearResult<null>> {
    return this.run(
      Q.ATTACHMENT_DELETE,
      { id },
      'attachmentDelete',
      'attachment delete'
    );
  }

  createComment(input: {
    issueId: string;
    body: string;
    parentId?: string;
  }): Promise<LinearResult<LinearComment>> {
    return this.mutate(
      Q.COMMENT_CREATE,
      { input },
      'commentCreate',
      'comment',
      toComment,
      'comment'
    );
  }

  updateComment(
    id: string,
    body: string
  ): Promise<LinearResult<LinearComment>> {
    return this.mutate(
      Q.COMMENT_UPDATE,
      { id, input: { body } },
      'commentUpdate',
      'comment',
      toComment,
      'comment update'
    );
  }

  deleteComment(id: string): Promise<LinearResult<null>> {
    return this.run(
      Q.COMMENT_DELETE,
      { id },
      'commentDelete',
      'comment delete'
    );
  }

  createProject(
    input: LinearProjectInput & { name: string; teamIds: string[] }
  ): Promise<LinearResult<LinearProject>> {
    return this.mutate(
      Q.PROJECT_CREATE,
      { input },
      'projectCreate',
      'project',
      toProject,
      'project'
    );
  }

  updateProject(
    id: string,
    input: LinearProjectInput
  ): Promise<LinearResult<LinearProject>> {
    return this.mutate(
      Q.PROJECT_UPDATE,
      { id, input },
      'projectUpdate',
      'project',
      toProject,
      'project update'
    );
  }

  createMilestone(
    input: LinearMilestoneInput & { name: string; projectId: string }
  ): Promise<LinearResult<LinearProjectMilestone>> {
    return this.mutate(
      Q.MILESTONE_CREATE,
      { input },
      'projectMilestoneCreate',
      'projectMilestone',
      toMilestone,
      'milestone'
    );
  }

  updateMilestone(
    id: string,
    input: LinearMilestoneInput
  ): Promise<LinearResult<LinearProjectMilestone>> {
    return this.mutate(
      Q.MILESTONE_UPDATE,
      { id, input },
      'projectMilestoneUpdate',
      'projectMilestone',
      toMilestone,
      'milestone update'
    );
  }

  createInitiative(
    input: LinearInitiativeInput & { name: string }
  ): Promise<LinearResult<LinearInitiative>> {
    return this.mutate(
      Q.INITIATIVE_CREATE,
      { input },
      'initiativeCreate',
      'initiative',
      toInitiative,
      'initiative'
    );
  }

  updateInitiative(
    id: string,
    input: LinearInitiativeInput
  ): Promise<LinearResult<LinearInitiative>> {
    return this.mutate(
      Q.INITIATIVE_UPDATE,
      { id, input },
      'initiativeUpdate',
      'initiative',
      toInitiative,
      'initiative update'
    );
  }

  linkProjectInitiative(
    projectId: string,
    initiativeId: string
  ): Promise<LinearResult<string>> {
    return this.mutate(
      Q.INITIATIVE_LINK,
      { input: { projectId, initiativeId } },
      'initiativeToProjectCreate',
      'initiativeToProject',
      (node: { id: string }) => node.id,
      'initiative link'
    );
  }

  unlinkProjectInitiative(linkId: string): Promise<LinearResult<null>> {
    return this.run(
      Q.INITIATIVE_UNLINK,
      { id: linkId },
      'initiativeToProjectDelete',
      'initiative unlink'
    );
  }

  createWebhook(input: LinearWebhookInput): Promise<LinearResult<string>> {
    return this.mutate(
      Q.WEBHOOK_CREATE,
      { input },
      'webhookCreate',
      'webhook',
      (node: { id: string }) => node.id,
      'webhook'
    );
  }

  deleteWebhook(id: string): Promise<LinearResult<null>> {
    return this.run(
      Q.WEBHOOK_DELETE,
      { id },
      'webhookDelete',
      'webhook delete'
    );
  }
}
