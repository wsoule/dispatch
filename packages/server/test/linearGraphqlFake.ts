// A fetch-level stand-in for Linear's GraphQL endpoint: it answers the
// operations HttpLinearClient sends, by operation name, with Relay-style
// pages cut at each query's own `first:`. It lets a test drive the real
// client and sync end to end without a socket or a key.
import type {
  LinearIssue,
  LinearLabel,
  LinearProject,
  LinearUser,
  LinearWorkflowState,
} from '@dispatch-foo/core';

export interface GraphqlWorld {
  viewer: LinearUser;
  members: LinearUser[];
  states: LinearWorkflowState[];
  labels: LinearLabel[];
  issues: LinearIssue[];
  projects: LinearProject[];
  /** Teams beyond the default HYD one, each on its own workflow. */
  teams?: {
    id: string;
    key: string;
    name: string;
    states: LinearWorkflowState[];
  }[];
}

export interface GraphqlRequest {
  operation: string;
  variables: Record<string, unknown>;
}

// A LinearIssue back in the GraphQL node shape the client parses.
function issueNode(i: LinearIssue): unknown {
  const ref = (id: string | null) => (id === null ? null : { id });
  const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description,
    priority: i.priority,
    estimate: i.estimate,
    url: i.url,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    archivedAt: i.archivedAt,
    dueDate: i.dueDate,
    state: i.state,
    team: i.team,
    assignee: ref(i.assigneeId),
    creator: ref(i.creatorId),
    cycle: i.cycle,
    project: ref(i.projectId),
    projectMilestone: ref(i.projectMilestoneId),
    parent: ref(i.parentId),
    labels: page(i.labels),
    relations: page(
      i.relations
        .filter((r) => r.issueId === i.id)
        .map((r) => ({
          id: r.id,
          type: r.type,
          issue: { id: r.issueId },
          relatedIssue: { id: r.relatedIssueId },
        }))
    ),
    inverseRelations: page(
      i.relations
        .filter((r) => r.relatedIssueId === i.id)
        .map((r) => ({
          id: r.id,
          type: r.type,
          issue: { id: r.issueId },
          relatedIssue: { id: r.relatedIssueId },
        }))
    ),
    attachments: page(i.attachments),
    children: page(i.childIds.map((id) => ({ id }))),
  };
}

function projectNode(p: LinearProject): unknown {
  return {
    id: p.id,
    name: p.name,
    description: p.summary,
    content: p.content,
    icon: p.icon,
    color: p.color,
    startDate: p.startDate,
    targetDate: p.targetDate,
    priority: p.priority,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt,
    lead: p.leadId === null ? null : { id: p.leadId },
    status: p.status,
    teams: { nodes: p.teamIds.map((id) => ({ id })) },
    initiativeToProjects: {
      nodes: p.initiatives.map((l) => ({
        id: l.id,
        initiative: { id: l.initiativeId },
      })),
    },
  };
}

function connection(all: unknown[], query: string, after: unknown): unknown {
  const first = Number(/first:\s*(\d+)/.exec(query)?.[1] ?? '50');
  const start = typeof after === 'string' ? Number(after) : 0;
  const nodes = all.slice(start, start + first);
  const end = start + nodes.length;
  return {
    nodes,
    pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
  };
}

const EMPTY = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

/** A fetch answering Linear's GraphQL from `world`, recording every request. */
export function graphqlFetch(world: GraphqlWorld): {
  fetch: typeof fetch;
  requests: GraphqlRequest[];
} {
  const requests: GraphqlRequest[] = [];
  const answer = (
    operation: string,
    query: string,
    v: Record<string, unknown>
  ): unknown => {
    const since = typeof v.since === 'string' ? v.since : null;
    const teamIssues = world.issues.filter(
      (i) => i.team?.id === v.teamId && (since === null || i.updatedAt > since)
    );
    const team = world.teams?.find((t) => t.id === v.teamId);
    switch (operation) {
      case 'Workspace':
        return {
          viewer: world.viewer,
          team: {
            id: v.teamId,
            key: team?.key ?? 'HYD',
            name: team?.name ?? 'Hydrogen',
            states: { nodes: team?.states ?? world.states },
            members: {
              nodes: world.members,
              pageInfo: { hasNextPage: false },
            },
          },
          projectStatuses: { nodes: [] },
        };
      case 'IssueLabels':
        return {
          issueLabels: connection(
            world.labels.map((l) => ({
              id: l.id,
              name: l.name,
              color: l.color ?? null,
              isGroup: false,
              team: l.teamId == null ? null : { id: l.teamId },
              parent: null,
            })),
            query,
            v.after
          ),
        };
      case 'IssuesAll':
      case 'IssuesUpdatedSince':
        return {
          issues: connection(teamIssues.map(issueNode), query, v.after),
        };
      case 'IssuesById': {
        const ids = new Set(v.ids as string[]);
        return {
          issues: connection(
            world.issues.filter((i) => ids.has(i.id)).map(issueNode),
            query,
            v.after
          ),
        };
      }
      case 'IssueLinks':
        return {
          issues: connection(
            teamIssues.map((i) => ({
              id: i.id,
              identifier: i.identifier,
              url: i.url,
              updatedAt: i.updatedAt,
            })),
            query,
            v.after
          ),
        };
      case 'ProjectsAll':
      case 'Projects':
        return {
          projects: connection(
            world.projects
              .filter(
                (p) =>
                  p.teamIds.includes(v.teamId as string) &&
                  (since === null || p.updatedAt > since)
              )
              .map(projectNode),
            query,
            v.after
          ),
        };
      case 'ProjectMilestonesAll':
      case 'ProjectMilestones':
        return { projectMilestones: EMPTY };
      case 'InitiativesAll':
      case 'Initiatives':
        return { initiatives: EMPTY };
      case 'CommentsAll':
      case 'CommentsUpdatedSince':
        return { comments: EMPTY };
      case 'Users':
        return { users: EMPTY };
      case 'Probe': {
        const hit = (yes: boolean) => ({ nodes: yes ? [{ id: 'x' }] : [] });
        return {
          issues: hit(teamIssues.length > 0),
          comments: hit(false),
          projects: hit(
            world.projects.some(
              (p) =>
                p.teamIds.includes(v.teamId as string) &&
                (since === null || p.updatedAt > since)
            )
          ),
          projectMilestones: hit(false),
          initiatives: hit(false),
          documents: hit(false),
        };
      }
      default:
        throw new Error(`fake Linear has no answer for ${operation}`);
    }
  };
  const fetchImpl = ((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? '';
    requests.push({ operation, variables: body.variables });
    const data = answer(operation, body.query, body.variables);
    return Promise.resolve(
      new Response(JSON.stringify({ data }), {
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}
