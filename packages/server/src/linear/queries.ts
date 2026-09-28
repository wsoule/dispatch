// GraphQL documents for Linear's API. Page sizes are set against Linear's
// per-query complexity ceiling (10,000 points; a connection multiplies its
// children by `first`), so every nested list here is capped and carries
// `pageInfo` — a cut-short list is reported, never mistaken for the whole.

// Linear splits the scalar it expects for a team id by position: the top-level
// `team(id:)` lookup takes `String!`, while the id comparators inside a filter
// (`IssueFilter.team.id.eq`) take `ID`. GraphQL does not coerce between the two,
// so a query declaring the wrong one fails validation before it ever runs
// ("Variable '$teamId' of type 'String!' used in position expecting type 'ID'").
// Keep `String!` on the `team(id:)` queries and `ID!` on the filtered ones.

/** Issues per page: ~255 points each (pessimistically) with the nested lists below. */
export const ISSUE_PAGE = 35;
export const COMMENT_PAGE = 100;
export const PROJECT_PAGE = 25;
export const MILESTONE_PAGE = 100;
export const INITIATIVE_PAGE = 50;
export const LABEL_PAGE = 250;
export const LINK_PAGE = 250;

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const HAS_MORE = 'pageInfo { hasNextPage }';

export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  estimate
  url
  createdAt
  updatedAt
  archivedAt
  dueDate
  state { id name type color position }
  team { id key }
  assignee { id }
  creator { id }
  cycle { id number name startsAt endsAt }
  project { id }
  projectMilestone { id }
  parent { id }
  labels(first: 20) { nodes { id name } ${HAS_MORE} }
  relations(first: 10) { nodes { id type issue { id } relatedIssue { id } } ${HAS_MORE} }
  inverseRelations(first: 10) { nodes { id type issue { id } relatedIssue { id } } ${HAS_MORE} }
  attachments(first: 10) { nodes { id title url subtitle sourceType } ${HAS_MORE} }
  children(first: 10) { nodes { id } ${HAS_MORE} }
`;

export const COMMENT_FIELDS = `
  id
  body
  createdAt
  updatedAt
  archivedAt
  user { id }
  parent { id }
  issue { id }
`;

export const PROJECT_FIELDS = `
  id
  name
  description
  content
  icon
  color
  startDate
  targetDate
  priority
  url
  createdAt
  updatedAt
  archivedAt
  lead { id }
  status { id name type color position }
  teams(first: 10) { nodes { id } }
  initiativeToProjects(first: 10) { nodes { id initiative { id } } }
`;

export const MILESTONE_FIELDS = `
  id
  name
  description
  targetDate
  sortOrder
  createdAt
  updatedAt
  archivedAt
  project { id }
`;

export const INITIATIVE_FIELDS = `
  id
  name
  description
  content
  status
  targetDate
  color
  icon
  url
  createdAt
  updatedAt
  archivedAt
  owner { id }
  creator { id }
`;

const USER_FIELDS = 'id name displayName email avatarUrl active';
const STATE_FIELDS = 'id name type color position';

export const VIEWER_QUERY = `query Viewer { viewer { ${USER_FIELDS} } }`;

export const TEAMS_QUERY = `query Teams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name }
    ${PAGE_INFO}
  }
}`;

export const STATES_QUERY = `query WorkflowStates($teamId: String!) {
  team(id: $teamId) { states(first: 100) { nodes { ${STATE_FIELDS} } } }
}`;

// Everything a pass needs about the team besides its issues, in one request.
export const WORKSPACE_QUERY = `query Workspace($teamId: String!) {
  viewer { ${USER_FIELDS} }
  team(id: $teamId) {
    id
    key
    name
    states(first: 100) { nodes { ${STATE_FIELDS} } }
    members(first: 100) { nodes { ${USER_FIELDS} } ${HAS_MORE} }
  }
  projectStatuses(first: 50) { nodes { id name type color position } }
}`;

// Workspace labels (team: null) apply to every team, so the walk is unfiltered
// and the client keeps the team's own plus the workspace's.
export const LABELS_QUERY = `query IssueLabels($after: String) {
  issueLabels(first: ${LABEL_PAGE}, after: $after) {
    nodes { id name color isGroup team { id } parent { name } }
    ${PAGE_INFO}
  }
}`;

export const CYCLES_QUERY = `query Cycles($teamId: String!, $after: String) {
  team(id: $teamId) {
    cycles(first: 50, after: $after) {
      nodes { id number name startsAt endsAt }
      ${PAGE_INFO}
    }
  }
}`;

export const USERS_QUERY = `query Users($ids: [ID!]!, $after: String) {
  users(first: 50, after: $after, filter: { id: { in: $ids } }, includeDisabled: true) {
    nodes { ${USER_FIELDS} }
    ${PAGE_INFO}
  }
}`;

// One cheap request answering "did anything change since the cursor?", so an
// idle poll costs a handful of points instead of a full issue page.
export const PROBE_QUERY = `query Probe($teamId: ID!, $since: DateTimeOrDuration!) {
  issues(first: 1, includeArchived: true, filter: { team: { id: { eq: $teamId } }, updatedAt: { gt: $since } }) { nodes { id } }
  comments(first: 1, includeArchived: true, filter: { issue: { team: { id: { eq: $teamId } } }, updatedAt: { gt: $since } }) { nodes { id } }
  projects(first: 1, includeArchived: true, filter: { accessibleTeams: { some: { id: { eq: $teamId } } }, updatedAt: { gt: $since } }) { nodes { id } }
  projectMilestones(first: 1, includeArchived: true, filter: { updatedAt: { gt: $since } }) { nodes { id } }
  initiatives(first: 1, includeArchived: true, filter: { updatedAt: { gt: $since } }) { nodes { id } }
}`;

export const ISSUES_QUERY = `query IssuesUpdatedSince($teamId: ID!, $since: DateTimeOrDuration, $after: String) {
  issues(
    filter: { team: { id: { eq: $teamId } }, updatedAt: { gt: $since } }
    first: ${ISSUE_PAGE}
    after: $after
    orderBy: updatedAt
    includeArchived: true
  ) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const ISSUES_QUERY_ALL = `query IssuesAll($teamId: ID!, $after: String) {
  issues(
    filter: { team: { id: { eq: $teamId } } }
    first: ${ISSUE_PAGE}
    after: $after
    orderBy: updatedAt
    includeArchived: true
  ) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const ISSUES_BY_ID_QUERY = `query IssuesById($ids: [ID!]!, $after: String) {
  issues(filter: { id: { in: $ids } }, first: ${ISSUE_PAGE}, after: $after, includeArchived: true) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const ISSUE_LINKS_QUERY = `query IssueLinks($teamId: ID!, $after: String) {
  issues(
    filter: { team: { id: { eq: $teamId } } }
    first: ${LINK_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { id identifier url updatedAt }
    ${PAGE_INFO}
  }
}`;

export const COMMENTS_QUERY = `query CommentsUpdatedSince($teamId: ID!, $since: DateTimeOrDuration, $after: String) {
  comments(
    filter: { issue: { team: { id: { eq: $teamId } } }, updatedAt: { gt: $since } }
    first: ${COMMENT_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${COMMENT_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const COMMENTS_QUERY_ALL = `query CommentsAll($teamId: ID!, $after: String) {
  comments(
    filter: { issue: { team: { id: { eq: $teamId } } } }
    first: ${COMMENT_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${COMMENT_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const COMMENTS_BY_ID_QUERY = `query CommentsById($ids: [ID!]!, $after: String) {
  comments(filter: { id: { in: $ids } }, first: ${COMMENT_PAGE}, after: $after, includeArchived: true) {
    nodes { ${COMMENT_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const PROJECTS_QUERY = `query Projects($teamId: ID!, $since: DateTimeOrDuration, $after: String) {
  projects(
    filter: { accessibleTeams: { some: { id: { eq: $teamId } } }, updatedAt: { gt: $since } }
    first: ${PROJECT_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${PROJECT_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const PROJECTS_QUERY_ALL = `query ProjectsAll($teamId: ID!, $after: String) {
  projects(
    filter: { accessibleTeams: { some: { id: { eq: $teamId } } } }
    first: ${PROJECT_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${PROJECT_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const MILESTONES_QUERY = `query ProjectMilestones($teamId: ID!, $since: DateTimeOrDuration, $after: String) {
  projectMilestones(
    filter: { project: { accessibleTeams: { some: { id: { eq: $teamId } } } }, updatedAt: { gt: $since } }
    first: ${MILESTONE_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${MILESTONE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const MILESTONES_QUERY_ALL = `query ProjectMilestonesAll($teamId: ID!, $after: String) {
  projectMilestones(
    filter: { project: { accessibleTeams: { some: { id: { eq: $teamId } } } } }
    first: ${MILESTONE_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${MILESTONE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const INITIATIVES_QUERY = `query Initiatives($since: DateTimeOrDuration, $after: String) {
  initiatives(
    filter: { updatedAt: { gt: $since } }
    first: ${INITIATIVE_PAGE}
    after: $after
    includeArchived: true
  ) {
    nodes { ${INITIATIVE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const INITIATIVES_QUERY_ALL = `query InitiativesAll($after: String) {
  initiatives(first: ${INITIATIVE_PAGE}, after: $after, includeArchived: true) {
    nodes { ${INITIATIVE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

export const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

export const ISSUE_ARCHIVE = `mutation IssueArchive($id: String!) {
  issueArchive(id: $id) { success entity { ${ISSUE_FIELDS} } }
}`;

export const ISSUE_UNARCHIVE = `mutation IssueUnarchive($id: String!) {
  issueUnarchive(id: $id) { success entity { ${ISSUE_FIELDS} } }
}`;

export const RELATION_CREATE = `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success issueRelation { id type issue { id } relatedIssue { id } } }
}`;

export const RELATION_DELETE = `mutation IssueRelationDelete($id: String!) {
  issueRelationDelete(id: $id) { success }
}`;

export const LABEL_CREATE = `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name color isGroup team { id } parent { name } } }
}`;

export const LABEL_UPDATE = `mutation IssueLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
  issueLabelUpdate(id: $id, input: $input) { success issueLabel { id name color isGroup team { id } parent { name } } }
}`;

export const ATTACHMENT_LINK = `mutation AttachmentLinkURL($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success attachment { id title url subtitle sourceType } }
}`;

export const ATTACHMENT_DELETE = `mutation AttachmentDelete($id: String!) {
  attachmentDelete(id: $id) { success }
}`;

export const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
}`;

export const COMMENT_UPDATE = `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { ${COMMENT_FIELDS} } }
}`;

export const COMMENT_DELETE = `mutation CommentDelete($id: String!) {
  commentDelete(id: $id) { success }
}`;

export const PROJECT_CREATE = `mutation ProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) { success project { ${PROJECT_FIELDS} } }
}`;

export const PROJECT_UPDATE = `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) { success project { ${PROJECT_FIELDS} } }
}`;

export const MILESTONE_CREATE = `mutation ProjectMilestoneCreate($input: ProjectMilestoneCreateInput!) {
  projectMilestoneCreate(input: $input) { success projectMilestone { ${MILESTONE_FIELDS} } }
}`;

export const MILESTONE_UPDATE = `mutation ProjectMilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) {
  projectMilestoneUpdate(id: $id, input: $input) { success projectMilestone { ${MILESTONE_FIELDS} } }
}`;

export const INITIATIVE_CREATE = `mutation InitiativeCreate($input: InitiativeCreateInput!) {
  initiativeCreate(input: $input) { success initiative { ${INITIATIVE_FIELDS} } }
}`;

export const INITIATIVE_UPDATE = `mutation InitiativeUpdate($id: String!, $input: InitiativeUpdateInput!) {
  initiativeUpdate(id: $id, input: $input) { success initiative { ${INITIATIVE_FIELDS} } }
}`;

export const INITIATIVE_LINK = `mutation InitiativeToProjectCreate($input: InitiativeToProjectCreateInput!) {
  initiativeToProjectCreate(input: $input) { success initiativeToProject { id } }
}`;

export const INITIATIVE_UNLINK = `mutation InitiativeToProjectDelete($id: String!) {
  initiativeToProjectDelete(id: $id) { success }
}`;

export const WEBHOOK_CREATE = `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) { success webhook { id enabled } }
}`;

export const WEBHOOK_DELETE = `mutation WebhookDelete($id: String!) {
  webhookDelete(id: $id) { success }
}`;
