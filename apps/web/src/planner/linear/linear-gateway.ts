// The LinearGateway backed by Linear's GraphQL API. It pages every root
// connection, maps nodes into core types (map.ts), refines "last state
// change" from issue history in aliased batches, and performs the writes
// the design allows (allocation, and a signed-in person's milestone date,
// project lead and, since the owner decision of 2026-10-21, issue edits).
// Transport, retries and error mapping live in client.ts; dropping
// relations whose ends are not mirrored is core's job.

import type {
  BlockingRelation,
  Initiative,
  IsoDate,
  IsoDateTime,
  Issue,
  IssueComment,
  IssueExtras,
  IssueLabel,
  IssuePatch,
  Milestone,
  Project,
  User,
} from '@dispatch/planning';

import {
  createGraphqlClient,
  type FetchLike,
  type GraphqlClient,
  LinearGraphqlErrors,
  type LinearLogger,
} from './client.js';
import {
  type FetchedWorkspace,
  LinearApiError,
  type LinearGateway,
  type LinearIdentity,
} from './gateway.js';
import {
  isRecord,
  type JsonObject,
  optionalString,
  readConnection,
  requireObject,
  requireString,
} from './json.js';
import {
  isArchivedNode,
  isLabelGroupNode,
  mapBlockingRelation,
  mapComment,
  mapEstimateScale,
  mapInitiative,
  mapIssue,
  mapIssueLabel,
  mapMilestone,
  mapProject,
  mapTeam,
  mapTeamMembership,
  mapUser,
  mapWorkflowState,
} from './map.js';
import {
  batchAlias,
  batchVariable,
  buildIssueHistoryBatchQuery,
  buildStateHistoryBatchQuery,
  COMMENT_CREATE_MUTATION,
  IDENTITY_QUERY,
  INITIATIVE_QUERY,
  INITIATIVES_QUERY,
  ISSUE_COMMENTS_MAX_PAGES,
  ISSUE_COMMENTS_PAGE_QUERY,
  ISSUE_DETAIL_QUERY,
  ISSUE_HISTORY_PAGE_QUERY,
  ISSUE_INVERSE_RELATIONS_PAGE_QUERY,
  ISSUE_LABELS_PAGE_QUERY,
  ISSUE_QUERY,
  ISSUE_RELATION_CREATE_MUTATION,
  ISSUE_RELATION_DELETE_MUTATION,
  ISSUE_RELATIONS_PAGE_QUERY,
  ISSUE_RELATIONS_QUERY,
  ISSUE_UPDATE_MUTATION,
  MILESTONE_QUERY,
  OPEN_ISSUES_WITHOUT_PROJECT_QUERY,
  PAGE_SIZE,
  PROJECT_ISSUES_QUERY,
  PROJECT_MILESTONE_UPDATE_MUTATION,
  PROJECT_MILESTONES_PAGE_QUERY,
  PROJECT_MILESTONES_QUERY,
  PROJECT_QUERY,
  PROJECT_UPDATE_MUTATION,
  PROJECTS_QUERY,
  STATE_CHANGE_BATCH_SIZE,
  STATE_HISTORY_PAGE_QUERY,
  TEAM_LABELS_QUERY,
  TEAM_MEMBERSHIPS_QUERY,
  TEAMS_QUERY,
  USER_QUERY,
  USERS_QUERY,
  WORKFLOW_STATES_QUERY,
  WORKSPACE_RELATIONS_QUERY,
} from './queries.js';

export interface LinearGatewayOptions {
  /** An OAuth access token. Exactly one of accessToken and apiKey. */
  accessToken?: string;
  /**
   * A personal API key's getter, read before every request attempt
   * (GraphqlClientOptions.apiKey). Exactly one of accessToken and apiKey.
   */
  apiKey?: () => string | null;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  logger?: LinearLogger;
  /** Defaults to https://api.linear.app/graphql. */
  endpoint?: string;
  /** Passed to the GraphQL client (tests inject a no-op sleep). */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  now?: () => number;
}

/**
 * Extra pages fetched per issue when its current state span or newest
 * history entry is not on the first page (issues with 50+ state changes).
 */
const MAX_EXTRA_HISTORY_PAGES = 4;

/** Upper bound for a nested connection (relations, milestones) of one entity. */
const MAX_NESTED_PAGES = 100;

const TIMELESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

const noopLogger: LinearLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function asData(value: unknown, operation: string): JsonObject {
  if (!isRecord(value)) {
    throw new LinearApiError(
      'graphql',
      `Malformed Linear response: ${operation} returned no data object`
    );
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return error instanceof LinearApiError && error.kind === 'not_found';
}

// GraphQL-level failures a fallback can work around (a field the token may
// not use, a malformed page); transport, auth and rate-limit errors are not.
function isQueryFailure(error: unknown): error is LinearApiError {
  return (
    error instanceof LinearApiError &&
    (error.kind === 'graphql' || error.kind === 'invalid_input')
  );
}

function maxIso(
  a: IsoDateTime | null,
  b: IsoDateTime | null
): IsoDateTime | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function normalizeIso(raw: string | null): IsoDateTime | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Start of the span the issue is in now: stateHistory spans whose endedAt
// is null. Linear does not document the order, so search every node.
function currentSpanStart(nodes: readonly JsonObject[]): IsoDateTime | null {
  let latest: IsoDateTime | null = null;
  for (const node of nodes) {
    const endedAt = node['endedAt'];
    if (endedAt !== null && endedAt !== undefined) continue;
    latest = maxIso(latest, normalizeIso(optionalString(node, 'startedAt')));
  }
  return latest;
}

// Fallback from Issue.history: the newest entry that changed the state
// (toStateId set). Order is not relied on either.
function latestStateChangeEntry(
  nodes: readonly JsonObject[]
): IsoDateTime | null {
  let latest: IsoDateTime | null = null;
  for (const node of nodes) {
    if (optionalString(node, 'toStateId') === null) continue;
    latest = maxIso(latest, normalizeIso(optionalString(node, 'createdAt')));
  }
  return latest;
}

// Which batch aliases (i0, i1…) a GraphQL error points at. Returns null when
// any error cannot be pinned to an alias, so the caller rethrows instead of
// silently dropping issues.
function failedAliasIndexes(error: unknown): Set<number> | null {
  if (!(error instanceof LinearApiError)) return null;
  if (
    !(
      error.kind === 'not_found' ||
      error.kind === 'graphql' ||
      error.kind === 'invalid_input'
    )
  ) {
    return null;
  }
  if (!(error.cause instanceof LinearGraphqlErrors)) return null;
  const indexes = new Set<number>();
  for (const info of error.cause.errors) {
    const head = info.path[0];
    const match = typeof head === 'string' ? /^i(\d+)$/.exec(head) : null;
    if (match?.[1] === undefined) return null;
    indexes.add(Number(match[1]));
  }
  return indexes.size > 0 ? indexes : null;
}

function missingCursor(connection: string): LinearApiError {
  return new LinearApiError(
    'graphql',
    `Linear said more ${connection} pages follow but sent no endCursor`
  );
}

/** Extra pages of a nested connection, and whether they reached the end. */
interface NestedPages {
  nodes: JsonObject[];
  complete: boolean;
}

interface AliasedBatchResult {
  /** Issue node per id that came back. */
  nodes: Map<string, JsonObject>;
  /** Ids whose alias failed (deleted issue, field unavailable…). */
  failed: string[];
}

const PATCH_KEYS: readonly (keyof IssuePatch)[] = [
  'title',
  'description',
  'stateId',
  'assigneeId',
  'priority',
  'projectId',
  'projectMilestoneId',
  'dueDate',
  'estimate',
  'labelIds',
];

function badPatch(message: string): LinearApiError {
  return new LinearApiError('invalid_input', message);
}

/**
 * The IssueUpdateInput for a person's edit: exactly the patch's keys (the
 * patch field names are Linear's), shape-checked so a malformed value
 * fails here instead of at Linear. The engine validates meaning (states of
 * the team, labels, the estimate scale) before it calls the gateway.
 */
function issueUpdateInput(patch: IssuePatch): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value: unknown = patch[key];
    if (value === undefined) continue;
    switch (key) {
      case 'title':
      case 'stateId':
        if (typeof value !== 'string')
          throw badPatch(`${key} must be a string`);
        break;
      case 'description':
      case 'assigneeId':
      case 'projectId':
      case 'projectMilestoneId':
        if (value !== null && typeof value !== 'string') {
          throw badPatch(`${key} must be a string or null`);
        }
        break;
      case 'priority':
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 4
        ) {
          throw badPatch('priority must be an integer from 0 to 4');
        }
        break;
      case 'dueDate':
        if (
          value !== null &&
          (typeof value !== 'string' || !TIMELESS_DATE.test(value))
        ) {
          throw badPatch(`dueDate must be YYYY-MM-DD or null`);
        }
        break;
      case 'estimate':
        // IssueUpdateInput.estimate is an Int.
        if (
          value !== null &&
          (typeof value !== 'number' || !Number.isInteger(value))
        ) {
          throw badPatch('estimate must be an integer or null');
        }
        break;
      case 'labelIds':
        if (
          !Array.isArray(value) ||
          !value.every((id): id is string => typeof id === 'string')
        ) {
          throw badPatch('labelIds must be a list of label ids');
        }
        break;
    }
    input[key] = value;
  }
  if (Object.keys(input).length === 0) {
    throw badPatch('updateIssueFields needs at least one field');
  }
  return input;
}

// The detail Linear gave for a GraphQL refusal: the first error's
// user-presentable message, else its message; null when there is none.
function refusalDetail(error: LinearApiError): string | null {
  if (!(error.cause instanceof LinearGraphqlErrors)) return null;
  const first = error.cause.errors[0];
  if (first === undefined) return null;
  return first.userPresentableMessage ?? first.message;
}

/**
 * Rewrites a write's LinearApiError into a sentence a person can act on
 * ("Linear refused to update the issue: Estimate is not valid"), keeping
 * its kind, retry time and the original error as cause. Other errors pass
 * through unchanged.
 */
function readableWriteError(error: unknown, action: string): unknown {
  if (!(error instanceof LinearApiError)) return error;
  const detail = refusalDetail(error);
  const suffix = detail === null ? '.' : `: ${detail}`;
  let message: string;
  switch (error.kind) {
    case 'invalid_input':
      message = `Linear refused to ${action}${suffix}`;
      break;
    case 'forbidden':
      message = `Linear does not let this account ${action}${suffix}`;
      break;
    case 'not_found':
      message = `Linear could not ${action}: something it refers to no longer exists${detail === null ? '.' : ` (${detail})`}`;
      break;
    case 'rate_limited':
      message = `Linear's rate limit was reached; could not ${action}.`;
      break;
    default:
      return error;
  }
  return new LinearApiError(error.kind, message, {
    retryAt: error.retryAt,
    cause: error,
  });
}

// Plain code-unit order (deterministic on every host).
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Comments oldest first; ties (same instant) by id so the order is stable.
function oldestFirst(a: IssueComment, b: IssueComment): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return byTime !== 0 ? byTime : compareText(a.id, b.id);
}

// Labels by name, then id.
function byLabelName(a: IssueLabel, b: IssueLabel): number {
  const byName = compareText(a.name, b.name);
  return byName !== 0 ? byName : compareText(a.id, b.id);
}

// Runs one write and makes its refusal readable (readableWriteError).
async function writing<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw readableWriteError(error, action);
  }
}

/**
 * Creates a gateway that talks to Linear with one credential: an OAuth
 * access token, or a personal API key read through its getter.
 */
export function createLinearGateway(
  options: LinearGatewayOptions
): LinearGateway {
  const logger = options.logger ?? noopLogger;
  const client: GraphqlClient = createGraphqlClient({
    ...(options.apiKey === undefined
      ? { accessToken: options.accessToken }
      : { apiKey: options.apiKey }),
    fetch: options.fetch,
    endpoint: options.endpoint,
    logger,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    now: options.now,
  });

  // Pages a root connection (`field` in the response) to the end, following
  // pageInfo.endCursor. A repeated cursor aborts instead of looping forever,
  // and "more pages" without a cursor aborts instead of returning a cut-off
  // list (the engine replaces the whole mirror with this result).
  async function fetchAllPages(
    query: string,
    field: string,
    variables: Record<string, unknown> = {}
  ): Promise<JsonObject[]> {
    const nodes: JsonObject[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const data = asData(
        await client.request<unknown>(query, {
          ...variables,
          first: PAGE_SIZE,
          after,
        }),
        field
      );
      const page = readConnection(data[field], field);
      for (const node of page.nodes) nodes.push(node);
      if (!page.hasNextPage) return nodes;
      if (page.endCursor === null) throw missingCursor(field);
      if (seenCursors.has(page.endCursor)) {
        throw new LinearApiError(
          'graphql',
          `Linear returned a repeated ${field} cursor`
        );
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }
  }

  // Follows a nested connection of one entity (e.g. a project's milestones)
  // after its first page, using a page query keyed by the entity id. Call it
  // only when the first page said hasNextPage. Reads at most `maxPages`
  // pages; `complete` is false when more remained, so callers that replace
  // mirrored data can refuse a partial list. A repeated or missing cursor
  // aborts so a bad response can neither loop nor truncate silently.
  async function fetchRemainingNested(
    pageQuery: string,
    root: string,
    field: string,
    id: string,
    firstCursor: string | null,
    maxPages: number
  ): Promise<NestedPages> {
    const nodes: JsonObject[] = [];
    const seenCursors = new Set<string>();
    let after = firstCursor;
    for (let page = 0; page < maxPages; page++) {
      if (after === null) throw missingCursor(`${root}.${field}`);
      if (seenCursors.has(after)) {
        throw new LinearApiError(
          'graphql',
          `Linear returned a repeated ${root}.${field} cursor`
        );
      }
      seenCursors.add(after);
      const data = asData(
        await client.request<unknown>(pageQuery, { id, after }),
        root
      );
      const entity = requireObject(data, root, root);
      const connection = readConnection(entity[field], `${root}.${field}`);
      for (const node of connection.nodes) nodes.push(node);
      if (!connection.hasNextPage) return { nodes, complete: true };
      after = connection.endCursor;
    }
    return { nodes, complete: false };
  }

  // Every remaining page of a nested list whose result replaces mirrored
  // data (a project's milestones, an issue's relations): a partial list
  // would make the engine delete the entries it did not see, so hitting
  // the page cap is an error rather than a silent cut.
  async function fetchAllNested(
    pageQuery: string,
    root: string,
    field: string,
    id: string,
    firstCursor: string | null
  ): Promise<JsonObject[]> {
    const result = await fetchRemainingNested(
      pageQuery,
      root,
      field,
      id,
      firstCursor,
      MAX_NESTED_PAGES
    );
    if (!result.complete) {
      throw new LinearApiError(
        'graphql',
        `Linear ${root}.${field} has more than ${MAX_NESTED_PAGES} extra pages`
      );
    }
    return result.nodes;
  }

  // Runs one aliased batch (`i0: issue(id: $id0) …`). When Linear rejects
  // specific aliases (e.g. a deleted issue makes the non-null root fail),
  // those ids are set aside and the rest are retried.
  async function runAliasedBatch(
    ids: readonly string[],
    build: (count: number) => string
  ): Promise<AliasedBatchResult> {
    let remaining = [...ids];
    const failed: string[] = [];
    while (remaining.length > 0) {
      const variables: Record<string, unknown> = {};
      remaining.forEach((id, i) => {
        variables[batchVariable(i)] = id;
      });
      try {
        const data = asData(
          await client.request<unknown>(build(remaining.length), variables),
          'batch'
        );
        const nodes = new Map<string, JsonObject>();
        remaining.forEach((id, i) => {
          const node = data[batchAlias(i)];
          if (isRecord(node)) nodes.set(id, node);
          else failed.push(id);
        });
        return { nodes, failed };
      } catch (error) {
        const indexes = failedAliasIndexes(error);
        if (indexes === null) throw error;
        const kept: string[] = [];
        remaining.forEach((id, i) => {
          if (indexes.has(i)) failed.push(id);
          else kept.push(id);
        });
        if (kept.length === remaining.length) throw error;
        remaining = kept;
      }
    }
    return { nodes: new Map(), failed };
  }

  // Refines up to STATE_CHANGE_BATCH_SIZE issues: current state span first,
  // then Issue.history for the issues stateHistory could not answer.
  async function refineBatch(
    batch: readonly string[],
    out: Map<string, IsoDateTime>
  ): Promise<void> {
    let spans: AliasedBatchResult;
    try {
      spans = await runAliasedBatch(batch, buildStateHistoryBatchQuery);
    } catch (error) {
      if (!isQueryFailure(error)) throw error;
      logger.warn(
        'linear stateHistory lookup failed; falling back to history',
        { issues: batch.length, error: error.message }
      );
      spans = { nodes: new Map(), failed: [...batch] };
    }

    const needHistory = [...spans.failed];
    for (const [id, node] of spans.nodes) {
      const connection = readConnection(
        node['stateHistory'],
        'Issue.stateHistory'
      );
      let started = currentSpanStart(connection.nodes);
      if (started === null && connection.hasNextPage) {
        try {
          const more = await fetchRemainingNested(
            STATE_HISTORY_PAGE_QUERY,
            'issue',
            'stateHistory',
            id,
            connection.endCursor,
            MAX_EXTRA_HISTORY_PAGES
          );
          started = currentSpanStart(more.nodes);
        } catch (error) {
          if (!isQueryFailure(error)) throw error;
        }
      }
      if (started === null) needHistory.push(id);
      else out.set(id, started);
    }
    if (needHistory.length === 0) return;

    const history = await runAliasedBatch(
      needHistory,
      buildIssueHistoryBatchQuery
    );
    const skipped = [...history.failed];
    for (const [id, node] of history.nodes) {
      const latest = await latestFromHistory(id, node);
      if (latest === null) skipped.push(id);
      else out.set(id, latest);
    }
    if (skipped.length > 0) {
      logger.debug('linear issues skipped in state-change lookup', {
        issueIds: skipped,
      });
    }
  }

  // The newest state change in one issue's Issue.history, reading extra
  // pages when needed. The order of history entries is undocumented, so a
  // history longer than the pages read (or a page that fails) gives no
  // answer rather than a possibly stale one: the caller then keeps the
  // timestamp approximation instead of making the issue look stalled.
  async function latestFromHistory(
    id: string,
    node: JsonObject
  ): Promise<IsoDateTime | null> {
    const connection = readConnection(node['history'], 'Issue.history');
    const latest = latestStateChangeEntry(connection.nodes);
    if (!connection.hasNextPage) return latest;
    let more: NestedPages;
    try {
      more = await fetchRemainingNested(
        ISSUE_HISTORY_PAGE_QUERY,
        'issue',
        'history',
        id,
        connection.endCursor,
        MAX_EXTRA_HISTORY_PAGES
      );
    } catch (error) {
      if (!isQueryFailure(error)) throw error;
      return null;
    }
    if (!more.complete) return null;
    return maxIso(latest, latestStateChangeEntry(more.nodes));
  }

  // Wraps a single-entity read: Linear answers a missing id with an
  // "Entity not found" error, which the gateway contract turns into null.
  async function readSingle(
    query: string,
    id: string,
    field: string
  ): Promise<JsonObject | null> {
    let data: JsonObject;
    try {
      data = asData(await client.request<unknown>(query, { id }), field);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const node = data[field];
    if (!isRecord(node) || isArchivedNode(node)) return null;
    return node;
  }

  // Checks a mutation payload's `success` flag and returns the entity field.
  function payloadEntity(
    data: JsonObject,
    mutation: string,
    field: string
  ): unknown {
    const payload = requireObject(data, mutation, mutation);
    if (payload['success'] !== true) {
      throw new LinearApiError(
        'graphql',
        `Linear ${mutation} reported success=false`
      );
    }
    const entity = payload[field];
    if (!isRecord(entity)) {
      throw new LinearApiError(
        'graphql',
        `Linear ${mutation} returned no ${field}`
      );
    }
    return entity;
  }

  // Every label of one issue: the first page from the detail query, then
  // the rest (a label set must be complete, since an edit sends the full
  // set back).
  async function issueLabels(
    issueId: string,
    node: JsonObject
  ): Promise<IssueLabel[]> {
    const first = readConnection(node['labels'], 'Issue.labels');
    const rest = first.hasNextPage
      ? await fetchAllNested(
          ISSUE_LABELS_PAGE_QUERY,
          'issue',
          'labels',
          issueId,
          first.endCursor
        )
      : [];
    return [...first.nodes, ...rest]
      .filter((label) => !isLabelGroupNode(label))
      .map(mapIssueLabel);
  }

  // Up to ISSUE_COMMENTS_MAX_PAGES pages of comments, oldest first (the
  // default direction of orderBy createdAt is undocumented, so sort here).
  async function issueComments(
    issueId: string,
    node: JsonObject
  ): Promise<{ comments: IssueComment[]; truncated: boolean }> {
    const first = readConnection(node['comments'], 'Issue.comments');
    let nodes = first.nodes;
    let truncated = false;
    if (first.hasNextPage) {
      const more = await fetchRemainingNested(
        ISSUE_COMMENTS_PAGE_QUERY,
        'issue',
        'comments',
        issueId,
        first.endCursor,
        ISSUE_COMMENTS_MAX_PAGES - 1
      );
      nodes = [...nodes, ...more.nodes];
      truncated = !more.complete;
    }
    const byId = new Map<string, IssueComment>();
    for (const comment of nodes.map(mapComment)) byId.set(comment.id, comment);
    const comments = [...byId.values()].sort(oldestFirst);
    return { comments, truncated };
  }

  const gateway: LinearGateway = {
    async whoAmI(): Promise<LinearIdentity> {
      const data = asData(
        await client.request<unknown>(IDENTITY_QUERY),
        'Identity'
      );
      const organization = requireObject(data, 'organization', 'Identity');
      return {
        user: mapUser(data['viewer']),
        workspace: {
          id: requireString(organization, 'id', 'Organization'),
          name: requireString(organization, 'name', 'Organization'),
          urlKey: requireString(organization, 'urlKey', 'Organization'),
        },
      };
    },

    async fetchWorkspace(): Promise<FetchedWorkspace> {
      const [
        identity,
        userNodes,
        teamNodes,
        stateNodes,
        initiativeNodes,
        projectNodes,
        milestoneNodes,
        projectIssueNodes,
        looseIssueNodes,
        relationNodes,
        membershipNodes,
      ] = await Promise.all([
        client.request<unknown>(IDENTITY_QUERY),
        fetchAllPages(USERS_QUERY, 'users'),
        fetchAllPages(TEAMS_QUERY, 'teams'),
        fetchAllPages(WORKFLOW_STATES_QUERY, 'workflowStates'),
        fetchAllPages(INITIATIVES_QUERY, 'initiatives'),
        fetchAllPages(PROJECTS_QUERY, 'projects'),
        fetchAllPages(PROJECT_MILESTONES_QUERY, 'projectMilestones'),
        fetchAllPages(PROJECT_ISSUES_QUERY, 'issues'),
        fetchAllPages(OPEN_ISSUES_WITHOUT_PROJECT_QUERY, 'issues'),
        fetchAllPages(WORKSPACE_RELATIONS_QUERY, 'issueRelations'),
        fetchAllPages(TEAM_MEMBERSHIPS_QUERY, 'teamMemberships'),
      ]);

      // Who belongs to which team (per-viewer visibility, §2.13).
      const membersByTeam = new Map<string, string[]>();
      for (const node of membershipNodes) {
        const membership = mapTeamMembership(node);
        if (membership === null) continue;
        const members = membersByTeam.get(membership.teamId);
        if (members === undefined) {
          membersByTeam.set(membership.teamId, [membership.userId]);
        } else if (!members.includes(membership.userId)) {
          members.push(membership.userId);
        }
      }

      const organization = requireObject(
        asData(identity, 'Identity'),
        'organization',
        'Identity'
      );
      const projects = projectNodes.map((node) => mapProject(node, logger));
      const projectIds = new Set(projects.map((p) => p.id));

      // The server-side filters already restrict milestones and issues to
      // mirrored projects; this keeps the mirror consistent if a project
      // was archived between pages.
      const milestones = milestoneNodes
        .map(mapMilestone)
        .filter((m) => projectIds.has(m.projectId));

      const issuesById = new Map<string, Issue>();
      for (const node of [...projectIssueNodes, ...looseIssueNodes]) {
        const issue = mapIssue(node);
        if (issue.projectId !== null && !projectIds.has(issue.projectId))
          continue;
        issuesById.set(issue.id, issue);
      }

      const relationsById = new Map<string, BlockingRelation>();
      for (const node of relationNodes) {
        const relation = mapBlockingRelation(node);
        if (relation !== null) relationsById.set(relation.id, relation);
      }

      return {
        workspaceId: requireString(organization, 'id', 'Organization'),
        organization: {
          name: requireString(organization, 'name', 'Organization'),
          urlKey: requireString(organization, 'urlKey', 'Organization'),
        },
        users: userNodes.map(mapUser),
        teams: teamNodes.map((node) => {
          const id = optionalString(node, 'id');
          return mapTeam(
            node,
            id === null ? [] : (membersByTeam.get(id) ?? []),
            logger
          );
        }),
        states: stateNodes.map((node) => mapWorkflowState(node, logger)),
        initiatives: initiativeNodes.map(mapInitiative),
        projects,
        milestones,
        issues: [...issuesById.values()],
        relations: [...relationsById.values()],
      };
    },

    async fetchLastStateChanges(
      issueIds: string[]
    ): Promise<Map<string, IsoDateTime>> {
      const unique = [...new Set(issueIds)];
      const out = new Map<string, IsoDateTime>();
      // Sequential batches keep a large refresh from bursting the rate limit.
      for (let i = 0; i < unique.length; i += STATE_CHANGE_BATCH_SIZE) {
        await refineBatch(unique.slice(i, i + STATE_CHANGE_BATCH_SIZE), out);
      }
      return out;
    },

    async fetchIssue(id: string): Promise<Issue | null> {
      const node = await readSingle(ISSUE_QUERY, id, 'issue');
      return node === null ? null : mapIssue(node);
    },

    async fetchIssueRelations(issueId: string): Promise<BlockingRelation[]> {
      const node = await readSingle(ISSUE_RELATIONS_QUERY, issueId, 'issue');
      if (node === null) return [];
      const owned = readConnection(node['relations'], 'Issue.relations');
      const inverse = readConnection(
        node['inverseRelations'],
        'Issue.inverseRelations'
      );
      const [moreOwned, moreInverse] = await Promise.all([
        owned.hasNextPage
          ? fetchAllNested(
              ISSUE_RELATIONS_PAGE_QUERY,
              'issue',
              'relations',
              issueId,
              owned.endCursor
            )
          : Promise.resolve([]),
        inverse.hasNextPage
          ? fetchAllNested(
              ISSUE_INVERSE_RELATIONS_PAGE_QUERY,
              'issue',
              'inverseRelations',
              issueId,
              inverse.endCursor
            )
          : Promise.resolve([]),
      ]);
      const byId = new Map<string, BlockingRelation>();
      for (const relationNode of [
        ...owned.nodes,
        ...moreOwned,
        ...inverse.nodes,
        ...moreInverse,
      ]) {
        const relation = mapBlockingRelation(relationNode);
        if (relation !== null) byId.set(relation.id, relation);
      }
      return [...byId.values()];
    },

    async fetchProject(
      id: string
    ): Promise<{ project: Project; milestones: Milestone[] } | null> {
      const node = await readSingle(PROJECT_QUERY, id, 'project');
      if (node === null) return null;
      const project = mapProject(node, logger);
      const first = readConnection(
        node['projectMilestones'],
        'Project.projectMilestones'
      );
      const rest = first.hasNextPage
        ? await fetchAllNested(
            PROJECT_MILESTONES_PAGE_QUERY,
            'project',
            'projectMilestones',
            id,
            first.endCursor
          )
        : [];
      return {
        project,
        milestones: [...first.nodes, ...rest].map(mapMilestone),
      };
    },

    async fetchMilestone(id: string): Promise<Milestone | null> {
      const node = await readSingle(MILESTONE_QUERY, id, 'projectMilestone');
      return node === null ? null : mapMilestone(node);
    },

    async fetchUser(id: string): Promise<User | null> {
      const node = await readSingle(USER_QUERY, id, 'user');
      return node === null ? null : mapUser(node);
    },

    async fetchInitiative(id: string): Promise<Initiative | null> {
      const node = await readSingle(INITIATIVE_QUERY, id, 'initiative');
      return node === null ? null : mapInitiative(node);
    },

    async updateIssue(
      id: string,
      input: { assigneeId?: string; stateId?: string }
    ): Promise<Issue> {
      // Only the provided fields are sent, so Linear leaves the rest alone.
      const patch: Record<string, string> = {};
      if (input.assigneeId !== undefined)
        patch['assigneeId'] = input.assigneeId;
      if (input.stateId !== undefined) patch['stateId'] = input.stateId;
      if (Object.keys(patch).length === 0) {
        throw new LinearApiError(
          'invalid_input',
          'updateIssue needs assigneeId or stateId'
        );
      }
      const data = asData(
        await client.request<unknown>(ISSUE_UPDATE_MUTATION, {
          id,
          input: patch,
        }),
        'issueUpdate'
      );
      const issue = mapIssue(payloadEntity(data, 'issueUpdate', 'issue'));
      // The state just changed, so the issue entered it at updatedAt; the
      // timestamp approximation alone would miss moves between open states.
      if (input.stateId !== undefined) {
        issue.lastStateChangeAt =
          maxIso(issue.lastStateChangeAt, issue.updatedAt) ?? issue.updatedAt;
      }
      return issue;
    },

    async createComment(
      issueId: string,
      body: string
    ): Promise<{ id: string }> {
      // Not idempotent: a retried 5xx could post the comment twice.
      const data = asData(
        await client.request<unknown>(
          COMMENT_CREATE_MUTATION,
          { input: { issueId, body } },
          { idempotent: false }
        ),
        'commentCreate'
      );
      const comment = payloadEntity(data, 'commentCreate', 'comment');
      return { id: requireString(asData(comment, 'Comment'), 'id', 'Comment') };
    },

    async updateMilestoneTargetDate(
      id: string,
      targetDate: IsoDate | null
    ): Promise<Milestone> {
      if (targetDate !== null && !TIMELESS_DATE.test(targetDate)) {
        throw new LinearApiError(
          'invalid_input',
          `targetDate must be YYYY-MM-DD: ${targetDate}`
        );
      }
      const data = asData(
        await client.request<unknown>(PROJECT_MILESTONE_UPDATE_MUTATION, {
          id,
          input: { targetDate },
        }),
        'projectMilestoneUpdate'
      );
      return mapMilestone(
        payloadEntity(data, 'projectMilestoneUpdate', 'projectMilestone')
      );
    },

    async updateProjectLead(
      id: string,
      leadId: string | null
    ): Promise<Project> {
      const data = asData(
        await client.request<unknown>(PROJECT_UPDATE_MUTATION, {
          id,
          input: { leadId },
        }),
        'projectUpdate'
      );
      return mapProject(
        payloadEntity(data, 'projectUpdate', 'project'),
        logger
      );
    },

    async fetchIssueDetail(issueId: string): Promise<IssueExtras | null> {
      const node = await readSingle(ISSUE_DETAIL_QUERY, issueId, 'issue');
      if (node === null) return null;
      const [labels, comments] = await Promise.all([
        issueLabels(issueId, node),
        issueComments(issueId, node),
      ]);
      const description = optionalString(node, 'description');
      const estimate = node['estimate'];
      const dueDate = optionalString(node, 'dueDate');
      return {
        issueId: requireString(node, 'id', 'Issue'),
        description:
          description === null || description.trim() === ''
            ? null
            : description,
        labels,
        estimate:
          typeof estimate === 'number' && Number.isFinite(estimate)
            ? estimate
            : null,
        dueDate:
          dueDate !== null && TIMELESS_DATE.test(dueDate.slice(0, 10))
            ? dueDate.slice(0, 10)
            : null,
        comments: comments.comments,
        commentsTruncated: comments.truncated,
        estimateScale: mapEstimateScale(
          requireObject(node, 'team', 'Issue'),
          logger
        ),
      };
    },

    async listIssueLabels(teamId: string): Promise<IssueLabel[]> {
      const nodes = await fetchAllPages(TEAM_LABELS_QUERY, 'issueLabels', {
        teamId,
      });
      const byId = new Map<string, IssueLabel>();
      for (const node of nodes) {
        if (isLabelGroupNode(node) || isArchivedNode(node)) continue;
        const label = mapIssueLabel(node);
        byId.set(label.id, label);
      }
      return [...byId.values()].sort(byLabelName);
    },

    async updateIssueFields(
      issueId: string,
      patch: IssuePatch
    ): Promise<Issue> {
      const input = issueUpdateInput(patch);
      return writing('update the issue', async () => {
        const data = asData(
          await client.request<unknown>(ISSUE_UPDATE_MUTATION, {
            id: issueId,
            input,
          }),
          'issueUpdate'
        );
        const issue = mapIssue(payloadEntity(data, 'issueUpdate', 'issue'));
        // As in updateIssue: a state change happened at updatedAt.
        if (input['stateId'] !== undefined) {
          issue.lastStateChangeAt =
            maxIso(issue.lastStateChangeAt, issue.updatedAt) ?? issue.updatedAt;
        }
        return issue;
      });
    },

    async createBlockingRelation(
      blockerIssueId: string,
      blockedIssueId: string
    ): Promise<BlockingRelation> {
      return writing('add the blocking relation', async () => {
        // Not idempotent: a retried 5xx could create the relation twice.
        const data = asData(
          await client.request<unknown>(
            ISSUE_RELATION_CREATE_MUTATION,
            {
              input: {
                issueId: blockerIssueId,
                relatedIssueId: blockedIssueId,
                type: 'blocks',
              },
            },
            { idempotent: false }
          ),
          'issueRelationCreate'
        );
        const relation = mapBlockingRelation(
          payloadEntity(data, 'issueRelationCreate', 'issueRelation')
        );
        if (relation === null) {
          throw new LinearApiError(
            'graphql',
            'Linear issueRelationCreate returned a relation that is not "blocks"'
          );
        }
        return relation;
      });
    },

    async deleteRelation(relationId: string): Promise<void> {
      await writing('remove the relation', async () => {
        const data = asData(
          await client.request<unknown>(ISSUE_RELATION_DELETE_MUTATION, {
            id: relationId,
          }),
          'issueRelationDelete'
        );
        const payload = requireObject(
          data,
          'issueRelationDelete',
          'issueRelationDelete'
        );
        if (payload['success'] !== true) {
          throw new LinearApiError(
            'graphql',
            'Linear issueRelationDelete reported success=false'
          );
        }
      });
    },
  };

  return gateway;
}
