// Small fixture builders so each test states only what matters to it.
// Dates are fixed around TODAY (2026-10-21) and NOW (15:00 UTC that day).

import {
  addDays,
  assessWorkspace,
  DEFAULT_TUNING,
  indexWorkspace,
} from '../src/index';
import type {
  EvalContext,
  Initiative,
  IsoDate,
  IsoDateTime,
  Issue,
  Milestone,
  MilestoneAssessment,
  MilestoneMeta,
  Project,
  Snapshot,
  Team,
  Tuning,
  User,
  WorkflowState,
  WorkspaceData,
} from '../src/index';

export const TODAY: IsoDate = '2026-10-21';
const NOW: IsoDateTime = '2026-10-21T15:00:00.000Z';
const TEAM = 'team-eng';

/** State ids of the default team's workflow. */
export const STATE: Record<
  'triage' | 'backlog' | 'todo' | 'started' | 'done' | 'canceled' | 'duplicate',
  string
> = {
  triage: 'st-triage',
  backlog: 'st-backlog',
  todo: 'st-todo',
  started: 'st-started',
  done: 'st-done',
  canceled: 'st-canceled',
  duplicate: 'st-duplicate',
};

/** `TODAY + days` as a calendar date. */
export function day(days: number): IsoDate {
  return addDays(TODAY, days);
}

/** NOW minus a number of days (fractions allowed), as an ISO instant. */
export function ago(days: number): IsoDateTime {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

/** A workflow like Linear's default, for one team. */
export function teamStates(teamId: string = TEAM): WorkflowState[] {
  const prefix = teamId === TEAM ? '' : `${teamId}:`;
  return [
    {
      id: `${prefix}${STATE.triage}`,
      teamId,
      name: 'Triage',
      type: 'triage',
      position: 0,
    },
    {
      id: `${prefix}${STATE.backlog}`,
      teamId,
      name: 'Backlog',
      type: 'backlog',
      position: 1,
    },
    {
      id: `${prefix}${STATE.todo}`,
      teamId,
      name: 'Todo',
      type: 'unstarted',
      position: 2,
    },
    {
      id: `${prefix}${STATE.started}`,
      teamId,
      name: 'In Progress',
      type: 'started',
      position: 3,
    },
    {
      id: `${prefix}${STATE.done}`,
      teamId,
      name: 'Done',
      type: 'completed',
      position: 4,
    },
    {
      id: `${prefix}${STATE.canceled}`,
      teamId,
      name: 'Canceled',
      type: 'canceled',
      position: 5,
    },
    // Linear's "duplicate" type arrives mapped to canceled.
    {
      id: `${prefix}${STATE.duplicate}`,
      teamId,
      name: 'Duplicate',
      type: 'canceled',
      position: 6,
    },
  ];
}

export function user(id: string, overrides: Partial<User> = {}): User {
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return {
    id,
    name,
    displayName: id,
    email: `${id}@example.com`,
    avatarUrl: null,
    active: true,
    app: false,
    ...overrides,
  };
}

export function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    url: `https://linear.app/acme/project/${id}`,
    leadId: 'lead',
    priority: 2,
    sortOrder: 0,
    statusType: 'started',
    statusName: 'In Progress',
    initiativeIds: [],
    teamIds: [TEAM],
    startDate: null,
    targetDate: null,
    ...overrides,
  };
}

export function initiative(
  id: string,
  overrides: Partial<Initiative> = {}
): Initiative {
  return {
    id,
    name: `Initiative ${id}`,
    sortOrder: 0,
    priority: 0,
    targetDate: null,
    ...overrides,
  };
}

/** A milestone that passes the rubric by default (date + done means). */
export function milestone(
  id: string,
  projectId: string,
  overrides: Partial<Milestone> = {}
): Milestone {
  return {
    id,
    projectId,
    name: `Milestone ${id}`,
    description: 'Done means: it ships',
    targetDate: day(20),
    sortOrder: 0,
    ...overrides,
  };
}

let issueCounter = 0;

/**
 * An open, unassigned Backlog issue by default, created a month ago and
 * last moved at NOW (so it is never stalled unless a test says so).
 */
export function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  issueCounter += 1;
  return {
    id,
    identifier: `ENG-${issueCounter}`,
    title: `Issue ${id}`,
    url: `https://linear.app/acme/issue/${id}`,
    teamId: TEAM,
    projectId: null,
    milestoneId: null,
    assigneeId: null,
    stateId: STATE.backlog,
    priority: 0,
    createdAt: ago(30),
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    lastStateChangeAt: NOW,
    ...overrides,
  };
}

/** `count` issues in one milestone, ids `<prefix>1..n`. */
export function issuesIn(
  prefix: string,
  projectId: string,
  milestoneId: string,
  count: number,
  overrides: Partial<Issue> = {}
): Issue[] {
  return Array.from({ length: count }, (_, i) =>
    issue(`${prefix}${i + 1}`, { projectId, milestoneId, ...overrides })
  );
}

/**
 * A public team (every workspace member sees it, §2.13) with no recorded
 * members unless given.
 */
function team(
  id: string,
  key: string,
  name: string,
  overrides: Partial<Team> = {}
): Team {
  return {
    id,
    key,
    name,
    visibility: 'public',
    parentId: null,
    memberIds: [],
    ...overrides,
  };
}

/** A workspace with a lead user and the default team unless overridden. */
export function workspace(parts: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    workspaceId: 'ws-1',
    users: [user('lead'), user('wyat'), user('shanzer')],
    teams: [team(TEAM, 'ENG', 'Engineering')],
    states: teamStates(),
    initiatives: [],
    projects: [],
    milestones: [],
    issues: [],
    relations: [],
    ...parts,
  };
}

export function meta(
  milestoneId: string,
  overrides: Partial<MilestoneMeta> = {}
): MilestoneMeta {
  return {
    milestoneId,
    weight: null,
    doneMeans: null,
    updatedAt: NOW,
    updatedBy: null,
    ...overrides,
  };
}

export function context(
  overrides: {
    today?: IsoDate;
    now?: IsoDateTime;
    tuning?: Partial<Tuning>;
    meta?: MilestoneMeta[];
  } = {}
): EvalContext {
  return {
    today: overrides.today ?? TODAY,
    now: overrides.now ?? NOW,
    tuning: { ...DEFAULT_TUNING, ...overrides.tuning },
    meta: new Map((overrides.meta ?? []).map((m) => [m.milestoneId, m])),
  };
}

export interface Evaluated {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: Map<string, MilestoneAssessment>;
}

/** Indexes and assesses a workspace in one step. */
export function evaluate(
  data: WorkspaceData,
  ctxOverrides: Parameters<typeof context>[0] = {}
): Evaluated {
  const snapshot = indexWorkspace(data);
  const ctx = context(ctxOverrides);
  return { snapshot, ctx, assessments: assessWorkspace(snapshot, ctx) };
}

/** The assessment of one milestone; throws when it is missing. */
export function assessmentOf(
  evaluated: Evaluated,
  milestoneId: string
): MilestoneAssessment {
  const found = evaluated.assessments.get(milestoneId);
  if (found === undefined) throw new Error(`no assessment for ${milestoneId}`);
  return found;
}
