// Every GraphQL document the gateway sends to Linear, as plain strings.
// test/schema.test.ts validates each one against the vendored SDL
// (schema/linear.graphql), which is what proves the field names are right.
//
// Complexity budget (architecture §4.1): one query may cost at most 10,000
// points and a connection multiplies its children by `first`, so root
// connections page with PAGE_SIZE and nested connections select ids only
// with a small explicit `first`.

/**
 * Page size for root connections: 50, Linear's documented default (its
 * maximum is not documented, architecture §4.1).
 */
export const PAGE_SIZE = 50;
/** Page size for connections nested inside single-entity queries. */
const NESTED_PAGE_SIZE = 50;
/**
 * `first` for a project's initiative and team id lists. They select
 * `pageInfo { hasNextPage }` so mapProject can log when a list is cut off.
 */
const PROJECT_REF_PAGE_SIZE = 10;
/** Issues per aliased state-change lookup. */
export const STATE_CHANGE_BATCH_SIZE = 20;
/** State spans / history entries per issue per request. */
const HISTORY_PAGE_SIZE = 50;

/**
 * Issue page (owner decision 2026-10-21): comments per page, and how many
 * pages one fetchIssueDetail reads at most (capping the comments one issue
 * page shows); Linear does not document the default
 * direction of `orderBy: createdAt`, so the gateway sorts what it read
 * oldest first and reports `commentsTruncated` when more remain.
 */
/**
 * Ancestors read above an issue's team for estimate inheritance: Linear
 * nests teams up to five levels deep (Enterprise; changelog 2026-04-09,
 * "multi-level sub-teams"), so the deepest team has four.
 */
const TEAM_ANCESTOR_LEVELS = 4;

// `{ ...EstimateScaleFields parent { …levels more… } }` for the issue
// detail's team: the team itself plus `levels` ancestors.
function estimateScaleChain(levels: number): string {
  return levels === 0
    ? '{ ...EstimateScaleFields }'
    : `{ ...EstimateScaleFields parent ${estimateScaleChain(levels - 1)} }`;
}

const ISSUE_COMMENTS_PAGE_SIZE = 50;
export const ISSUE_COMMENTS_MAX_PAGES = 4;
/** Labels of one issue per page (an issue's label set is read in full). */
const ISSUE_LABELS_PAGE_SIZE = 50;

/** Project status types the mirror leaves out. */
const CLOSED_PROJECT_STATUSES = '["completed", "canceled"]';
/** Issue state types that count as closed ("duplicate" is a Linear extra). */
const CLOSED_ISSUE_STATES = '["completed", "canceled", "duplicate"]';

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const USER_FIELDS = `
fragment UserFields on User {
  id
  name
  displayName
  email
  active
  avatarUrl
  app
  guest
}`;

// visibility (public | private | restricted; Team.private is deprecated in
// its favour) and the parent decide who may see a team (architecture
// §2.13); members come from TEAM_MEMBERSHIPS_QUERY.
const TEAM_FIELDS = `
fragment TeamFields on Team {
  id
  key
  name
  visibility
  parent { id }
}`;

const WORKFLOW_STATE_FIELDS = `
fragment WorkflowStateFields on WorkflowState {
  id
  name
  type
  position
  team { id }
}`;

const INITIATIVE_FIELDS = `
fragment InitiativeFields on Initiative {
  id
  name
  sortOrder
  priority
  targetDate
}`;

const PROJECT_FIELDS = `
fragment ProjectFields on Project {
  id
  name
  url
  priority
  sortOrder
  startDate
  targetDate
  lead { id }
  status { type name }
  initiatives(first: ${PROJECT_REF_PAGE_SIZE}) {
    nodes { id }
    pageInfo { hasNextPage }
  }
  teams(first: ${PROJECT_REF_PAGE_SIZE}) {
    nodes { id }
    pageInfo { hasNextPage }
  }
}`;

const MILESTONE_FIELDS = `
fragment MilestoneFields on ProjectMilestone {
  id
  name
  description
  targetDate
  sortOrder
  project { id }
}`;

const ISSUE_FIELDS = `
fragment IssueFields on Issue {
  id
  identifier
  title
  url
  priority
  createdAt
  updatedAt
  startedAt
  completedAt
  canceledAt
  dueDate
  team { id }
  project { id }
  projectMilestone { id }
  assignee { id }
  state { id }
}`;

const RELATION_FIELDS = `
fragment RelationFields on IssueRelation {
  id
  type
  issue { id }
  relatedIssue { id }
}`;

// A label as the issue page needs it: its group (parent) decides whether
// two labels exclude each other; groups themselves cannot be applied.
const ISSUE_LABEL_FIELDS = `
fragment IssueLabelFields on IssueLabel {
  id
  name
  color
  isGroup
  team { id }
  parent { id name groupType }
}`;

const COMMENT_FIELDS = `
fragment CommentFields on Comment {
  id
  body
  createdAt
  url
  parent { id }
  user { id name }
  botActor { name }
  externalUser { name }
}`;

// A team's estimate settings. A sub-team may inherit them from its parent,
// at every level, so the issue detail reads the team's ancestors with the
// same fragment (TEAM_ANCESTOR_LEVELS of them).
const ESTIMATE_SCALE_FIELDS = `
fragment EstimateScaleFields on Team {
  id
  issueEstimationType
  issueEstimationAllowZero
  issueEstimationExtended
  inheritIssueEstimation
}`;

const STATE_SPANS_FIELDS = `
fragment StateSpans on Issue {
  id
  stateHistory(first: ${HISTORY_PAGE_SIZE}) {
    nodes { startedAt endedAt }
    ${PAGE_INFO}
  }
}`;

const HISTORY_FIELDS = `
fragment StateHistoryEntries on Issue {
  id
  history(first: ${HISTORY_PAGE_SIZE}) {
    nodes { createdAt toStateId }
    ${PAGE_INFO}
  }
}`;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Who the token acts as, and which workspace it belongs to. */
export const IDENTITY_QUERY: string = `
query Identity {
  viewer { ...UserFields }
  organization { id name urlKey }
}
${USER_FIELDS}`;

// ---------------------------------------------------------------------------
// Workspace mirror (root connections, paged with $first/$after)
// ---------------------------------------------------------------------------

/** All users, deactivated ones included (inactive leads must stay visible). */
export const USERS_QUERY: string = `
query Users($first: Int!, $after: String) {
  users(first: $first, after: $after, includeDisabled: true) {
    nodes { ...UserFields }
    ${PAGE_INFO}
  }
}
${USER_FIELDS}`;

export const TEAMS_QUERY: string = `
query Teams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { ...TeamFields }
    ${PAGE_INFO}
  }
}
${TEAM_FIELDS}`;

/**
 * Every team membership the app can see (root connection, archived ones
 * left out by default): who belongs to which team, for per-viewer
 * visibility.
 */
export const TEAM_MEMBERSHIPS_QUERY: string = `
query TeamMemberships($first: Int!, $after: String) {
  teamMemberships(first: $first, after: $after) {
    nodes { team { id } user { id } }
    ${PAGE_INFO}
  }
}`;

export const WORKFLOW_STATES_QUERY: string = `
query WorkflowStates($first: Int!, $after: String) {
  workflowStates(first: $first, after: $after) {
    nodes { ...WorkflowStateFields }
    ${PAGE_INFO}
  }
}
${WORKFLOW_STATE_FIELDS}`;

export const INITIATIVES_QUERY: string = `
query Initiatives($first: Int!, $after: String) {
  initiatives(first: $first, after: $after) {
    nodes { ...InitiativeFields }
    ${PAGE_INFO}
  }
}
${INITIATIVE_FIELDS}`;

/** Projects that are not completed or canceled (archived are excluded). */
export const PROJECTS_QUERY: string = `
query Projects($first: Int!, $after: String) {
  projects(
    first: $first
    after: $after
    filter: { status: { type: { nin: ${CLOSED_PROJECT_STATUSES} } } }
  ) {
    nodes { ...ProjectFields }
    ${PAGE_INFO}
  }
}
${PROJECT_FIELDS}`;

/** Milestones of the projects PROJECTS_QUERY returns. */
export const PROJECT_MILESTONES_QUERY: string = `
query ProjectMilestones($first: Int!, $after: String) {
  projectMilestones(
    first: $first
    after: $after
    filter: { project: { status: { type: { nin: ${CLOSED_PROJECT_STATUSES} } } } }
  ) {
    nodes { ...MilestoneFields }
    ${PAGE_INFO}
  }
}
${MILESTONE_FIELDS}`;

/**
 * Issues that belong to a mirrored project, open and closed (closed ones
 * count towards milestone progress).
 */
export const PROJECT_ISSUES_QUERY: string = `
query ProjectIssues($first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    filter: {
      project: {
        null: false
        status: { type: { nin: ${CLOSED_PROJECT_STATUSES} } }
      }
    }
  ) {
    nodes { ...IssueFields }
    ${PAGE_INFO}
  }
}
${ISSUE_FIELDS}`;

/** Open issues with no project, for My week's "No milestone" section. */
export const OPEN_ISSUES_WITHOUT_PROJECT_QUERY: string = `
query OpenIssuesWithoutProject($first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    filter: {
      project: { null: true }
      state: { type: { nin: ${CLOSED_ISSUE_STATES} } }
    }
  ) {
    nodes { ...IssueFields }
    ${PAGE_INFO}
  }
}
${ISSUE_FIELDS}`;

/** Every issue relation (the root connection has no filter argument). */
export const WORKSPACE_RELATIONS_QUERY: string = `
query IssueRelations($first: Int!, $after: String) {
  issueRelations(first: $first, after: $after) {
    nodes { ...RelationFields }
    ${PAGE_INFO}
  }
}
${RELATION_FIELDS}`;

// ---------------------------------------------------------------------------
// Single entities (webhook refetches)
// ---------------------------------------------------------------------------

export const ISSUE_QUERY: string = `
query Issue($id: String!) {
  issue(id: $id) {
    ...IssueFields
    archivedAt
    trashed
  }
}
${ISSUE_FIELDS}`;

/** A project with the first page of its milestones. */
export const PROJECT_QUERY: string = `
query Project($id: String!) {
  project(id: $id) {
    ...ProjectFields
    archivedAt
    projectMilestones(first: ${NESTED_PAGE_SIZE}) {
      nodes { ...MilestoneFields }
      ${PAGE_INFO}
    }
  }
}
${PROJECT_FIELDS}
${MILESTONE_FIELDS}`;

/** Further pages of a project's milestones. */
export const PROJECT_MILESTONES_PAGE_QUERY: string = `
query ProjectMilestonesPage($id: String!, $after: String) {
  project(id: $id) {
    id
    projectMilestones(first: ${NESTED_PAGE_SIZE}, after: $after) {
      nodes { ...MilestoneFields }
      ${PAGE_INFO}
    }
  }
}
${MILESTONE_FIELDS}`;

export const MILESTONE_QUERY: string = `
query ProjectMilestone($id: String!) {
  projectMilestone(id: $id) {
    ...MilestoneFields
    archivedAt
  }
}
${MILESTONE_FIELDS}`;

export const USER_QUERY: string = `
query User($id: String!) {
  user(id: $id) { ...UserFields }
}
${USER_FIELDS}`;

export const INITIATIVE_QUERY: string = `
query Initiative($id: String!) {
  initiative(id: $id) {
    ...InitiativeFields
    archivedAt
  }
}
${INITIATIVE_FIELDS}`;

/**
 * Both sides of one issue's relations: `relations` are the ones it owns
 * (for "blocks": it blocks relatedIssue), `inverseRelations` point at it
 * (for "blocks": issue blocks it).
 */
export const ISSUE_RELATIONS_QUERY: string = `
query IssueRelationsForIssue($id: String!) {
  issue(id: $id) {
    id
    relations(first: ${NESTED_PAGE_SIZE}) {
      nodes { ...RelationFields }
      ${PAGE_INFO}
    }
    inverseRelations(first: ${NESTED_PAGE_SIZE}) {
      nodes { ...RelationFields }
      ${PAGE_INFO}
    }
  }
}
${RELATION_FIELDS}`;

export const ISSUE_RELATIONS_PAGE_QUERY: string = `
query IssueRelationsPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    relations(first: ${NESTED_PAGE_SIZE}, after: $after) {
      nodes { ...RelationFields }
      ${PAGE_INFO}
    }
  }
}
${RELATION_FIELDS}`;

export const ISSUE_INVERSE_RELATIONS_PAGE_QUERY: string = `
query IssueInverseRelationsPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    inverseRelations(first: ${NESTED_PAGE_SIZE}, after: $after) {
      nodes { ...RelationFields }
      ${PAGE_INFO}
    }
  }
}
${RELATION_FIELDS}`;

// ---------------------------------------------------------------------------
// Issue page (owner decision 2026-10-21): live fields the mirror does not keep
// ---------------------------------------------------------------------------

/**
 * Description, estimate, due date, the first page of labels and comments,
 * and the team's estimate scale (with up to two parent teams, for
 * sub-teams that inherit it). Labels include archived ones: Linear keeps
 * an archived label on the issues that carry it (linear.app/docs/labels),
 * and an edit sends the whole set back (labelIds), so a set read without
 * them would make any label edit drop them.
 */
export const ISSUE_DETAIL_QUERY: string = `
query IssueDetail($id: String!) {
  issue(id: $id) {
    id
    description
    estimate
    dueDate
    archivedAt
    trashed
    team ${estimateScaleChain(TEAM_ANCESTOR_LEVELS)}
    labels(first: ${ISSUE_LABELS_PAGE_SIZE}, includeArchived: true) {
      nodes { ...IssueLabelFields }
      ${PAGE_INFO}
    }
    comments(first: ${ISSUE_COMMENTS_PAGE_SIZE}, orderBy: createdAt) {
      nodes { ...CommentFields }
      ${PAGE_INFO}
    }
  }
}
${ESTIMATE_SCALE_FIELDS}
${ISSUE_LABEL_FIELDS}
${COMMENT_FIELDS}`;

/** Further pages of one issue's labels (archived ones included). */
export const ISSUE_LABELS_PAGE_QUERY: string = `
query IssueLabelsPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    labels(first: ${ISSUE_LABELS_PAGE_SIZE}, after: $after, includeArchived: true) {
      nodes { ...IssueLabelFields }
      ${PAGE_INFO}
    }
  }
}
${ISSUE_LABEL_FIELDS}`;

/** Further pages of one issue's comments. */
export const ISSUE_COMMENTS_PAGE_QUERY: string = `
query IssueCommentsPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: ${ISSUE_COMMENTS_PAGE_SIZE}, after: $after, orderBy: createdAt) {
      nodes { ...CommentFields }
      ${PAGE_INFO}
    }
  }
}
${COMMENT_FIELDS}`;

/**
 * Labels usable on one team's issues: the team's own and workspace labels
 * (team null). Archived labels are excluded by default; label groups are
 * dropped by the gateway.
 */
export const TEAM_LABELS_QUERY: string = `
query TeamIssueLabels($first: Int!, $after: String, $teamId: ID!) {
  issueLabels(
    first: $first
    after: $after
    filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }
  ) {
    nodes { ...IssueLabelFields }
    ${PAGE_INFO}
  }
}
${ISSUE_LABEL_FIELDS}`;

// ---------------------------------------------------------------------------
// Last state change (Issue.stateHistory, falling back to Issue.history)
// ---------------------------------------------------------------------------

/** Response alias for the n-th issue of a batch (`i0`, `i1`, …). */
export function batchAlias(index: number): string {
  return `i${index}`;
}

/** Variable name for the n-th issue id of a batch (`id0`, `id1`, …). */
export function batchVariable(index: number): string {
  return `id${index}`;
}

// Builds `query Name($id0: String!, …) { i0: issue(id: $id0) { ...F } … }`
// so one request covers up to STATE_CHANGE_BATCH_SIZE issues.
function aliasedIssueBatch(
  name: string,
  fragmentName: string,
  fragment: string,
  count: number
): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`batch size must be a positive integer: ${count}`);
  }
  const vars: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    vars.push(`$${batchVariable(i)}: String!`);
    fields.push(
      `  ${batchAlias(i)}: issue(id: $${batchVariable(i)}) { ...${fragmentName} }`
    );
  }
  return `
query ${name}(${vars.join(', ')}) {
${fields.join('\n')}
}
${fragment}`;
}

/** State spans for `count` issues; the span with endedAt null is current. */
export function buildStateHistoryBatchQuery(count: number): string {
  return aliasedIssueBatch(
    'IssueStateSpans',
    'StateSpans',
    STATE_SPANS_FIELDS,
    count
  );
}

/** Fallback: history entries (newest toStateId change wins). */
export function buildIssueHistoryBatchQuery(count: number): string {
  return aliasedIssueBatch(
    'IssueStateHistory',
    'StateHistoryEntries',
    HISTORY_FIELDS,
    count
  );
}

/** Further pages of one issue's state spans. */
export const STATE_HISTORY_PAGE_QUERY: string = `
query IssueStateSpansPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    stateHistory(first: ${HISTORY_PAGE_SIZE}, after: $after) {
      nodes { startedAt endedAt }
      ${PAGE_INFO}
    }
  }
}`;

/** Further pages of one issue's history. */
export const ISSUE_HISTORY_PAGE_QUERY: string = `
query IssueHistoryPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    history(first: ${HISTORY_PAGE_SIZE}, after: $after) {
      nodes { createdAt toStateId }
      ${PAGE_INFO}
    }
  }
}`;

// ---------------------------------------------------------------------------
// Mutations: the writes the design allows (§8 and the owner decision of
// 2026-10-21; issue edits always use the editing person's token)
// ---------------------------------------------------------------------------

/**
 * Edit an issue; `input` carries only the provided fields. Allocation sends
 * assigneeId/stateId; a person's edit any IssuePatch field.
 */
export const ISSUE_UPDATE_MUTATION: string = `
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { ...IssueFields }
  }
}
${ISSUE_FIELDS}`;

export const COMMENT_CREATE_MUTATION: string = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`;

export const PROJECT_MILESTONE_UPDATE_MUTATION: string = `
mutation ProjectMilestoneUpdate(
  $id: String!
  $input: ProjectMilestoneUpdateInput!
) {
  projectMilestoneUpdate(id: $id, input: $input) {
    success
    projectMilestone { ...MilestoneFields }
  }
}
${MILESTONE_FIELDS}`;

export const PROJECT_UPDATE_MUTATION: string = `
mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) {
    success
    project { ...ProjectFields }
  }
}
${PROJECT_FIELDS}`;

/** "issue blocks relatedIssue" (input type: blocks). */
export const ISSUE_RELATION_CREATE_MUTATION: string = `
mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { ...RelationFields }
  }
}
${RELATION_FIELDS}`;

export const ISSUE_RELATION_DELETE_MUTATION: string = `
mutation IssueRelationDelete($id: String!) {
  issueRelationDelete(id: $id) {
    success
    entityId
  }
}`;
