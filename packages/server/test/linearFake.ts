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
  LinearUser,
  LinearWorkflowState,
  TaskCycle,
} from '@dispatch-foo/core';

import type {
  LinearClient,
  LinearFailure,
  LinearIssuePage,
  LinearIssueRef,
  LinearPage,
  LinearProbe,
  LinearResult,
  LinearTeam,
  LinearViewer,
  LinearWebhookInput,
  LinearWorkspace,
} from '../src/linear/client.js';

const TEAM_ID = 'team-1';

export const STATES: LinearWorkflowState[] = [
  {
    id: 's-backlog',
    name: 'Backlog',
    type: 'backlog',
    color: '#bbbbbb',
    position: 0,
  },
  {
    id: 's-todo',
    name: 'Todo',
    type: 'unstarted',
    color: '#e2e2e2',
    position: 1,
  },
  {
    id: 's-progress',
    name: 'In Progress',
    type: 'started',
    color: '#f2c94c',
    position: 2,
  },
  {
    id: 's-review',
    name: 'In Review',
    type: 'started',
    color: '#0f783c',
    position: 3,
  },
  {
    id: 's-done',
    name: 'Done',
    type: 'completed',
    color: '#5e6ad2',
    position: 4,
  },
  {
    id: 's-cancelled',
    name: 'Canceled',
    type: 'canceled',
    color: '#95a2b3',
    position: 5,
  },
];

export const LABELS: LinearLabel[] = [{ id: 'l-web', name: 'web' }];

export const VIEWER: LinearUser = {
  id: 'u-me',
  name: 'Wyat Soule',
  displayName: 'wyat',
  email: 'wyat@example.com',
  avatarUrl: 'https://avatars.example/wyat.png',
  active: true,
};

export const TEAMMATE: LinearUser = {
  id: 'u-ana',
  name: 'Ana Lima',
  displayName: 'ana',
  email: 'ana@example.com',
  avatarUrl: null,
  active: true,
};

const PROJECT_STATUSES: LinearProjectStatus[] = [
  { id: 'ps-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'ps-planned', name: 'Planned', type: 'planned' },
  { id: 'ps-started', name: 'In Progress', type: 'started' },
  { id: 'ps-paused', name: 'Paused', type: 'paused' },
  { id: 'ps-completed', name: 'Completed', type: 'completed' },
  { id: 'ps-canceled', name: 'Canceled', type: 'canceled' },
];

export type Method = keyof LinearClient;

function ok<T>(data: T): Promise<LinearResult<T>> {
  return Promise.resolve({ ok: true, data });
}

function missing(what: string, id: string): Promise<LinearFailure> {
  return Promise.resolve({
    ok: false,
    kind: 'graphql',
    error: `unknown ${what}: ${id}`,
  });
}

/**
 * An in-memory Linear standing in for the GraphQL client: it records every
 * call and applies mutations the way Linear would, so a pull after a push sees
 * what the push produced. No test using it opens a socket.
 */
export class FakeLinearClient implements LinearClient {
  /** The team-1 workflow, and every other team's unless `teamStates` names it. */
  states: LinearWorkflowState[] = STATES;
  teamList: LinearTeam[] = [{ id: TEAM_ID, key: 'HYD', name: 'Hydrogen' }];
  /** Workflows of teams beyond team-1, by team id. */
  teamStates: Record<string, LinearWorkflowState[]> = {};
  labelList: LinearLabel[] = LABELS.map((l) => ({ ...l }));
  members: LinearUser[] = [VIEWER];
  viewerUser: LinearUser = VIEWER;
  projectStatuses: LinearProjectStatus[] = PROJECT_STATUSES;
  cycleList: TaskCycle[] = [];
  issues: LinearIssue[] = [];
  commentList: LinearComment[] = [];
  projectList: LinearProject[] = [];
  milestoneList: LinearProjectMilestone[] = [];
  initiativeList: LinearInitiative[] = [];
  webhooks = new Map<string, LinearWebhookInput>();

  created: LinearIssueInput[] = [];
  updated: { id: string; input: LinearIssueInput }[] = [];
  /** Every call, by method name, in order. */
  calls: Method[] = [];
  /** A failure a method returns instead of answering. */
  failures: Partial<Record<Method, LinearFailure>> = {};
  issuesFailure: LinearFailure | null = null;
  createFailure: LinearFailure | null = null;
  linkFailure: LinearFailure | null = null;
  /** Runs inside createIssue, standing in for a local edit landing mid-round-trip. */
  onCreate: (() => void) | null = null;
  /** Runs as any method is called: a local edit landing while a pass waits on Linear. */
  onCall: ((method: Method) => void) | null = null;
  truncated = false;
  sinceSeen: (string | null)[] = [];
  linkQueries = 0;
  private seq = 0;
  private tick = 0;

  // A written entity comes back stamped ahead of the local clock, which is what makes echo
  // suppression load-bearing: on the next pull our own write looks newer than the local file.
  stamp(): string {
    return new Date(Date.now() + 5_000 + ++this.tick).toISOString();
  }

  private next(): number {
    return ++this.seq;
  }

  private fail(method: Method): LinearFailure | null {
    this.calls.push(method);
    this.onCall?.(method);
    return this.failures[method] ?? null;
  }

  viewer(): Promise<LinearResult<LinearViewer>> {
    const f = this.fail('viewer');
    if (f !== null) return Promise.resolve(f);
    const v = this.viewerUser;
    return ok({ id: v.id, name: v.name, email: v.email ?? '' });
  }

  teams(): Promise<LinearResult<LinearTeam[]>> {
    const f = this.fail('teams');
    if (f !== null) return Promise.resolve(f);
    return ok([...this.teamList]);
  }

  /** A team's workflow states. */
  statesOf(teamId: string): LinearWorkflowState[] {
    return this.teamStates[teamId] ?? this.states;
  }

  private teamOf(teamId: string): LinearTeam {
    return (
      this.teamList.find((t) => t.id === teamId) ?? {
        id: teamId,
        key: 'HYD',
        name: 'Hydrogen',
      }
    );
  }

  workflowStates(teamId: string): Promise<LinearResult<LinearWorkflowState[]>> {
    const f = this.fail('workflowStates');
    if (f !== null) return Promise.resolve(f);
    return ok(this.statesOf(teamId));
  }

  workspace(teamId: string): Promise<LinearResult<LinearWorkspace>> {
    const f = this.fail('workspace');
    if (f !== null) return Promise.resolve(f);
    return ok({
      viewer: this.viewerUser,
      team: this.teamOf(teamId),
      states: this.statesOf(teamId),
      members: this.members,
      projectStatuses: this.projectStatuses,
    });
  }

  /** The team's labels plus the workspace's, as Linear scopes them. */
  labels(teamId: string): Promise<LinearResult<LinearLabel[]>> {
    const f = this.fail('labels');
    if (f !== null) return Promise.resolve(f);
    return ok(
      this.labelList
        .filter((l) => l.teamId == null || l.teamId === teamId)
        .map((l) => ({ ...l }))
    );
  }

  cycles(): Promise<LinearResult<TaskCycle[]>> {
    const f = this.fail('cycles');
    if (f !== null) return Promise.resolve(f);
    return ok([...this.cycleList]);
  }

  users(ids: string[]): Promise<LinearResult<LinearUser[]>> {
    const f = this.fail('users');
    if (f !== null) return Promise.resolve(f);
    return ok(this.members.filter((m) => ids.includes(m.id)));
  }

  probe(teamId: string, since: string): Promise<LinearResult<LinearProbe>> {
    const f = this.fail('probe');
    if (f !== null) return Promise.resolve(f);
    const after = (at: string) => at > since;
    return ok({
      issues: this.issues.some(
        (i) => i.team?.id === teamId && after(i.updatedAt)
      ),
      comments: this.commentList.some((c) => after(c.updatedAt)),
      projects: this.projectList.some((p) => after(p.updatedAt)),
      milestones: this.milestoneList.some((m) => after(m.updatedAt)),
      initiatives: this.initiativeList.some((i) => after(i.updatedAt)),
    });
  }

  issuesUpdatedSince(
    teamId: string,
    since: string | null,
    onPage?: (fetched: number) => void
  ): Promise<LinearResult<LinearIssuePage>> {
    const f = this.fail('issuesUpdatedSince') ?? this.issuesFailure;
    if (f !== null) return Promise.resolve(f);
    this.sinceSeen.push(since);
    const nodes = this.issues.filter(
      (i) =>
        (i.team === null || i.team.id === teamId) &&
        (since === null || i.updatedAt > since)
    );
    onPage?.(nodes.length);
    return ok({
      issues: nodes.map((i) => structuredClone(i)),
      truncated: this.truncated,
    });
  }

  issuesByIds(ids: string[]): Promise<LinearResult<LinearIssue[]>> {
    const f = this.fail('issuesByIds');
    if (f !== null) return Promise.resolve(f);
    return ok(
      this.issues
        .filter((i) => ids.includes(i.id))
        .map((i) => structuredClone(i))
    );
  }

  issueLinks(teamId: string): Promise<LinearResult<LinearIssueRef[]>> {
    const f = this.fail('issueLinks') ?? this.linkFailure;
    if (f !== null) return Promise.resolve(f);
    this.linkQueries++;
    return ok(
      this.issues
        .filter((i) => i.team === null || i.team.id === teamId)
        .map((i) => ({
          id: i.id,
          identifier: i.identifier,
          url: i.url,
          updatedAt: i.updatedAt,
        }))
    );
  }

  comments(
    _teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearComment>>> {
    const f = this.fail('comments');
    if (f !== null) return Promise.resolve(f);
    return ok({
      nodes: this.commentList
        .filter((c) => since === null || c.updatedAt > since)
        .map((c) => ({ ...c })),
      truncated: false,
    });
  }

  commentsByIds(ids: string[]): Promise<LinearResult<LinearComment[]>> {
    const f = this.fail('commentsByIds');
    if (f !== null) return Promise.resolve(f);
    return ok(
      this.commentList.filter((c) => ids.includes(c.id)).map((c) => ({ ...c }))
    );
  }

  projects(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearProject>>> {
    const f = this.fail('projects');
    if (f !== null) return Promise.resolve(f);
    return ok({
      nodes: this.projectList
        .filter(
          (p) =>
            p.teamIds.includes(teamId) &&
            (since === null || p.updatedAt > since)
        )
        .map((p) => structuredClone(p)),
      truncated: false,
    });
  }

  projectMilestones(
    teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearProjectMilestone>>> {
    const f = this.fail('projectMilestones');
    if (f !== null) return Promise.resolve(f);
    const projects = new Set(
      this.projectList
        .filter((p) => p.teamIds.includes(teamId))
        .map((p) => p.id)
    );
    return ok({
      nodes: this.milestoneList
        .filter(
          (m) =>
            projects.has(m.projectId) && (since === null || m.updatedAt > since)
        )
        .map((m) => ({ ...m })),
      truncated: false,
    });
  }

  initiatives(
    since: string | null
  ): Promise<LinearResult<LinearPage<LinearInitiative>>> {
    const f = this.fail('initiatives');
    if (f !== null) return Promise.resolve(f);
    return ok({
      nodes: this.initiativeList
        .filter((i) => since === null || i.updatedAt > since)
        .map((i) => ({ ...i })),
      truncated: false,
    });
  }

  createIssue(input: LinearIssueInput): Promise<LinearResult<LinearIssue>> {
    const f = this.fail('createIssue') ?? this.createFailure;
    if (f !== null) return Promise.resolve(f);
    this.onCreate?.();
    this.created.push(input);
    const n = this.next();
    const issue = this.apply(this.blank(`issue-${n}`, `HYD-${n}`), input);
    this.issues.push(issue);
    return ok(structuredClone(issue));
  }

  updateIssue(
    id: string,
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    const f = this.fail('updateIssue');
    if (f !== null) return Promise.resolve(f);
    this.updated.push({ id, input });
    const index = this.issues.findIndex((i) => i.id === id);
    if (index < 0) return missing('issue', id);
    this.issues[index] = this.apply(this.issues[index], input);
    return ok(structuredClone(this.issues[index]));
  }

  archiveIssue(id: string): Promise<LinearResult<LinearIssue>> {
    return this.touchIssue('archiveIssue', id, (i) => {
      i.archivedAt = this.stamp();
    });
  }

  unarchiveIssue(id: string): Promise<LinearResult<LinearIssue>> {
    return this.touchIssue('unarchiveIssue', id, (i) => {
      i.archivedAt = null;
    });
  }

  private touchIssue(
    method: Method,
    id: string,
    change: (issue: LinearIssue) => void
  ): Promise<LinearResult<LinearIssue>> {
    const f = this.fail(method);
    if (f !== null) return Promise.resolve(f);
    const issue = this.issues.find((i) => i.id === id);
    if (issue === undefined) return missing('issue', id);
    change(issue);
    issue.updatedAt = this.stamp();
    return ok(structuredClone(issue));
  }

  createRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: string;
  }): Promise<LinearResult<LinearRelation>> {
    const f = this.fail('createRelation');
    if (f !== null) return Promise.resolve(f);
    const relation: LinearRelation = { id: `rel-${this.next()}`, ...input };
    for (const issue of this.issues) {
      if (issue.id === input.issueId || issue.id === input.relatedIssueId) {
        issue.relations.push({ ...relation });
      }
    }
    return ok(relation);
  }

  deleteRelation(id: string): Promise<LinearResult<null>> {
    const f = this.fail('deleteRelation');
    if (f !== null) return Promise.resolve(f);
    for (const issue of this.issues) {
      issue.relations = issue.relations.filter((r) => r.id !== id);
    }
    return ok(null);
  }

  createLabel(input: {
    name: string;
    teamId: string;
    color?: string;
  }): Promise<LinearResult<LinearLabel>> {
    const f = this.fail('createLabel');
    if (f !== null) return Promise.resolve(f);
    const label: LinearLabel = {
      id: `l-${this.next()}`,
      name: input.name,
      ...(input.color === undefined ? {} : { color: input.color }),
      teamId: input.teamId,
      group: null,
    };
    this.labelList.push(label);
    return ok({ ...label });
  }

  updateLabel(
    id: string,
    input: { color: string }
  ): Promise<LinearResult<LinearLabel>> {
    const f = this.fail('updateLabel');
    if (f !== null) return Promise.resolve(f);
    const at = this.labelList.findIndex((l) => l.id === id);
    if (at < 0) return missing('label', id);
    const label = { ...this.labelList[at], color: input.color };
    this.labelList[at] = label;
    return ok({ ...label });
  }

  linkAttachment(
    issueId: string,
    url: string,
    title: string
  ): Promise<LinearResult<LinearAttachment>> {
    const f = this.fail('linkAttachment');
    if (f !== null) return Promise.resolve(f);
    const issue = this.issues.find((i) => i.id === issueId);
    if (issue === undefined) return missing('issue', issueId);
    const existing = issue.attachments.find((a) => a.url === url);
    const attachment: LinearAttachment = existing ?? {
      id: `att-${this.next()}`,
      title,
      url,
      subtitle: null,
      sourceType: null,
    };
    attachment.title = title;
    if (existing === undefined) issue.attachments.push(attachment);
    return ok({ ...attachment });
  }

  deleteAttachment(id: string): Promise<LinearResult<null>> {
    const f = this.fail('deleteAttachment');
    if (f !== null) return Promise.resolve(f);
    for (const issue of this.issues) {
      issue.attachments = issue.attachments.filter((a) => a.id !== id);
    }
    return ok(null);
  }

  createComment(input: {
    issueId: string;
    body: string;
    parentId?: string;
  }): Promise<LinearResult<LinearComment>> {
    const f = this.fail('createComment');
    if (f !== null) return Promise.resolve(f);
    const at = this.stamp();
    const comment: LinearComment = {
      id: `cm-${this.next()}`,
      issueId: input.issueId,
      body: input.body,
      userId: this.viewerUser.id,
      parentId: input.parentId ?? null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    };
    this.commentList.push(comment);
    return ok({ ...comment });
  }

  updateComment(
    id: string,
    body: string
  ): Promise<LinearResult<LinearComment>> {
    const f = this.fail('updateComment');
    if (f !== null) return Promise.resolve(f);
    const comment = this.commentList.find((c) => c.id === id);
    if (comment === undefined) return missing('comment', id);
    comment.body = body;
    comment.updatedAt = this.stamp();
    return ok({ ...comment });
  }

  deleteComment(id: string): Promise<LinearResult<null>> {
    const f = this.fail('deleteComment');
    if (f !== null) return Promise.resolve(f);
    this.commentList = this.commentList.filter(
      (c) => c.id !== id && c.parentId !== id
    );
    return ok(null);
  }

  createProject(
    input: LinearProjectInput & { name: string; teamIds: string[] }
  ): Promise<LinearResult<LinearProject>> {
    const f = this.fail('createProject');
    if (f !== null) return Promise.resolve(f);
    const project = this.project({ id: `proj-${this.next()}` });
    this.projectList.push(project);
    this.applyProject(project, input);
    return ok(structuredClone(project));
  }

  updateProject(
    id: string,
    input: LinearProjectInput
  ): Promise<LinearResult<LinearProject>> {
    const f = this.fail('updateProject');
    if (f !== null) return Promise.resolve(f);
    const project = this.projectList.find((p) => p.id === id);
    if (project === undefined) return missing('project', id);
    this.applyProject(project, input);
    return ok(structuredClone(project));
  }

  private applyProject(
    project: LinearProject,
    input: LinearProjectInput
  ): void {
    if (input.name !== undefined) project.name = input.name;
    if (input.content !== undefined) project.content = input.content;
    if (input.leadId !== undefined) project.leadId = input.leadId;
    if (input.statusId !== undefined) {
      project.status =
        this.projectStatuses.find((s) => s.id === input.statusId) ?? null;
    }
    if (input.startDate !== undefined) project.startDate = input.startDate;
    if (input.targetDate !== undefined) project.targetDate = input.targetDate;
    if (input.color !== undefined) project.color = input.color;
    if (input.icon !== undefined) project.icon = input.icon;
    if (input.priority !== undefined) project.priority = input.priority;
    if (input.teamIds !== undefined) project.teamIds = input.teamIds;
    project.updatedAt = this.stamp();
  }

  createMilestone(
    input: LinearMilestoneInput & { name: string; projectId: string }
  ): Promise<LinearResult<LinearProjectMilestone>> {
    const f = this.fail('createMilestone');
    if (f !== null) return Promise.resolve(f);
    const at = this.stamp();
    const milestone: LinearProjectMilestone = {
      id: `ms-${this.next()}`,
      name: input.name,
      description: input.description ?? null,
      targetDate: input.targetDate ?? null,
      sortOrder: input.sortOrder ?? this.milestoneList.length,
      projectId: input.projectId,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    };
    this.milestoneList.push(milestone);
    return ok({ ...milestone });
  }

  updateMilestone(
    id: string,
    input: LinearMilestoneInput
  ): Promise<LinearResult<LinearProjectMilestone>> {
    const f = this.fail('updateMilestone');
    if (f !== null) return Promise.resolve(f);
    const m = this.milestoneList.find((x) => x.id === id);
    if (m === undefined) return missing('milestone', id);
    if (input.name !== undefined) m.name = input.name;
    if (input.description !== undefined) m.description = input.description;
    if (input.targetDate !== undefined) m.targetDate = input.targetDate;
    if (input.projectId !== undefined) m.projectId = input.projectId;
    if (input.sortOrder !== undefined) m.sortOrder = input.sortOrder;
    m.updatedAt = this.stamp();
    return ok({ ...m });
  }

  createInitiative(
    input: LinearInitiativeInput & { name: string }
  ): Promise<LinearResult<LinearInitiative>> {
    const f = this.fail('createInitiative');
    if (f !== null) return Promise.resolve(f);
    const initiative = this.initiative({ id: `init-${this.next()}` });
    this.initiativeList.push(initiative);
    this.applyInitiative(initiative, input);
    return ok({ ...initiative });
  }

  updateInitiative(
    id: string,
    input: LinearInitiativeInput
  ): Promise<LinearResult<LinearInitiative>> {
    const f = this.fail('updateInitiative');
    if (f !== null) return Promise.resolve(f);
    const initiative = this.initiativeList.find((i) => i.id === id);
    if (initiative === undefined) return missing('initiative', id);
    this.applyInitiative(initiative, input);
    return ok({ ...initiative });
  }

  private applyInitiative(
    initiative: LinearInitiative,
    input: LinearInitiativeInput
  ): void {
    if (input.name !== undefined) initiative.name = input.name;
    if (input.content !== undefined) initiative.content = input.content;
    if (input.ownerId !== undefined) initiative.ownerId = input.ownerId;
    if (input.status !== undefined) initiative.status = input.status;
    if (input.targetDate !== undefined) {
      initiative.targetDate = input.targetDate;
    }
    if (input.color !== undefined) initiative.color = input.color;
    if (input.icon !== undefined) initiative.icon = input.icon;
    initiative.updatedAt = this.stamp();
  }

  linkProjectInitiative(
    projectId: string,
    initiativeId: string
  ): Promise<LinearResult<string>> {
    const f = this.fail('linkProjectInitiative');
    if (f !== null) return Promise.resolve(f);
    const project = this.projectList.find((p) => p.id === projectId);
    if (project === undefined) return missing('project', projectId);
    const id = `i2p-${this.next()}`;
    project.initiatives.push({ id, initiativeId });
    project.updatedAt = this.stamp();
    return ok(id);
  }

  unlinkProjectInitiative(linkId: string): Promise<LinearResult<null>> {
    const f = this.fail('unlinkProjectInitiative');
    if (f !== null) return Promise.resolve(f);
    for (const project of this.projectList) {
      const before = project.initiatives.length;
      project.initiatives = project.initiatives.filter((l) => l.id !== linkId);
      if (project.initiatives.length !== before) {
        project.updatedAt = this.stamp();
      }
    }
    return ok(null);
  }

  createWebhook(input: LinearWebhookInput): Promise<LinearResult<string>> {
    const f = this.fail('createWebhook');
    if (f !== null) return Promise.resolve(f);
    const id = `wh-${this.next()}`;
    this.webhooks.set(id, input);
    return ok(id);
  }

  deleteWebhook(id: string): Promise<LinearResult<null>> {
    const f = this.fail('deleteWebhook');
    if (f !== null) return Promise.resolve(f);
    this.webhooks.delete(id);
    return ok(null);
  }

  // Applies a mutation input the way Linear would: absent keys untouched, null clears.
  private apply(base: LinearIssue, input: LinearIssueInput): LinearIssue {
    const next = structuredClone(base);
    if (input.title !== undefined) next.title = input.title;
    if (input.description !== undefined) next.description = input.description;
    if (input.priority !== undefined) next.priority = input.priority;
    if (input.estimate !== undefined) next.estimate = input.estimate;
    if (input.stateId !== undefined) {
      const all = [...this.states, ...Object.values(this.teamStates).flat()];
      next.state = all.find((s) => s.id === input.stateId) ?? next.state;
    }
    if (input.assigneeId !== undefined) next.assigneeId = input.assigneeId;
    if (input.labelIds !== undefined) {
      next.labels = this.labelList
        .filter((l) => (input.labelIds ?? []).includes(l.id))
        .map((l) => ({ id: l.id, name: l.name }));
    }
    if (input.dueDate !== undefined) next.dueDate = input.dueDate;
    if (input.cycleId !== undefined) {
      next.cycle =
        input.cycleId === null
          ? null
          : (this.cycleList.find((c) => c.id === input.cycleId) ?? null);
    }
    if (input.projectId !== undefined) next.projectId = input.projectId;
    if (input.projectMilestoneId !== undefined) {
      next.projectMilestoneId = input.projectMilestoneId;
    }
    if (input.parentId !== undefined) next.parentId = input.parentId;
    if (input.teamId !== undefined) {
      next.team = { id: input.teamId, key: this.teamOf(input.teamId).key };
    }
    next.updatedAt = this.stamp();
    return next;
  }

  private blank(id: string, identifier: string): LinearIssue {
    const at = this.stamp();
    return {
      id,
      identifier,
      title: '',
      description: null,
      priority: 0,
      estimate: null,
      url: `https://linear.app/acme/issue/${identifier}`,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      dueDate: null,
      state: null,
      labels: [],
      team: { id: TEAM_ID, key: 'HYD' },
      assigneeId: null,
      creatorId: this.viewerUser.id,
      cycle: null,
      projectId: null,
      projectMilestoneId: null,
      parentId: null,
      childIds: [],
      relations: [],
      attachments: [],
      truncated: [],
    };
  }

  /** A remote issue for a test to seed, defaulting to a started, labelled one. */
  issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
    const n = this.next();
    return {
      ...this.blank(`issue-${n}`, `HYD-${n}`),
      title: `Issue ${n}`,
      description: 'from linear',
      priority: 2,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
      state: this.states[2] ?? null,
      labels: this.labelList
        .slice(0, 1)
        .map((l) => ({ id: l.id, name: l.name })),
      ...overrides,
    };
  }

  /** A remote project in the linked team. */
  project(overrides: Partial<LinearProject> = {}): LinearProject {
    const n = this.next();
    return {
      id: `proj-${n}`,
      name: `Project ${n}`,
      summary: '',
      content: null,
      icon: null,
      color: '#5e6ad2',
      startDate: null,
      targetDate: null,
      leadId: null,
      status: this.projectStatuses[2] ?? null,
      priority: 0,
      url: `https://linear.app/acme/project/p-${n}`,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
      archivedAt: null,
      teamIds: [TEAM_ID],
      initiatives: [],
      ...overrides,
    };
  }

  /** A remote initiative. */
  initiative(overrides: Partial<LinearInitiative> = {}): LinearInitiative {
    const n = this.next();
    return {
      id: `init-${n}`,
      name: `Initiative ${n}`,
      description: null,
      content: null,
      ownerId: null,
      creatorId: null,
      status: 'Active',
      targetDate: null,
      color: null,
      icon: null,
      url: `https://linear.app/acme/initiative/i-${n}`,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
      archivedAt: null,
      ...overrides,
    };
  }
}
