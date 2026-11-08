// Building blocks shared by the demo workspaces: the base one in fixture.ts
// (LINEAR_FIXTURE=1) and the larger showcase in showcase.ts
// (LINEAR_FIXTURE=showcase). Internal to the package (index.ts does not
// re-export it). Moved out of fixture.ts unchanged, so the base workspace
// is byte-for-byte what it was (test/base-snapshot.test.ts proves it).

import type {
  IsoDate,
  IsoDateTime,
  Issue,
  Priority,
  ProjectStatusType,
  User,
  WorkflowState,
  WorkflowStateType,
} from '@dispatch/planning';

// ---------------------------------------------------------------------------
// Local date helpers (core's date helpers are not a dependency here)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `date` plus `days` calendar days, computed in UTC so DST never shifts it. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const match = ISO_DATE.exec(date);
  if (match === null) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** An instant on `today - daysAgo` at a fixed UTC time of day. */
function daysAgo(
  today: IsoDate,
  days: number,
  time = '09:00:00.000'
): IsoDateTime {
  return `${addDays(today, -days)}T${time}Z`;
}

/** Lowercase words joined by dashes, as Linear builds URL slugs. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// People and workflow states
// ---------------------------------------------------------------------------

/** A demo person: display name and email from the first name. */
export function person(
  id: string,
  name: string,
  options: { active?: boolean; guest?: boolean } = {}
): User {
  const first = name.split(' ')[0] ?? name;
  return {
    id,
    name,
    displayName: first.toLowerCase(),
    email: `${first.toLowerCase()}@northwind.example`,
    avatarUrl: null,
    active: options.active ?? true,
    app: false,
    guest: options.guest ?? false,
  };
}

export type StateKey =
  | 'triage'
  | 'backlog'
  | 'todo'
  | 'progress'
  | 'review'
  | 'done'
  | 'canceled'
  | 'duplicate';

// Linear's default workflow plus Triage and a Duplicate state. Duplicate is
// already normalised to type canceled, as the real gateway maps it.
const STATE_DEFS: readonly {
  key: StateKey;
  name: string;
  type: WorkflowStateType;
}[] = [
  { key: 'triage', name: 'Triage', type: 'triage' },
  { key: 'backlog', name: 'Backlog', type: 'backlog' },
  { key: 'todo', name: 'Todo', type: 'unstarted' },
  { key: 'progress', name: 'In Progress', type: 'started' },
  { key: 'review', name: 'In Review', type: 'started' },
  { key: 'done', name: 'Done', type: 'completed' },
  { key: 'canceled', name: 'Canceled', type: 'canceled' },
  { key: 'duplicate', name: 'Duplicate', type: 'canceled' },
];

/** The id of a team's workflow state (`team` is the lowercase team key). */
function stateId(team: string, key: StateKey): string {
  return `st-${team}-${key}`;
}

/** Every listed team's full workflow, team by team, in STATE_DEFS order. */
export function buildStates(teams: readonly string[]): WorkflowState[] {
  const states: WorkflowState[] = [];
  for (const team of teams) {
    STATE_DEFS.forEach((def, position) => {
      states.push({
        id: stateId(team, def.key),
        teamId: `team-${team}`,
        name: def.name,
        type: def.type,
        position,
      });
    });
  }
  return states;
}

// ---------------------------------------------------------------------------
// Projects and issues
// ---------------------------------------------------------------------------

export const STATUS_NAME: Record<ProjectStatusType, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  started: 'In Progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
};

export function projectId(key: string): string {
  return `proj-${key}`;
}

export function issueId(team: string, number: number): string {
  return `iss-${team}-${number}`;
}

/** One demo issue before it gets its ids, URL and timestamps. */
export interface IssueSpec {
  /** Lowercase team key; the identifier prefix is its uppercase form. */
  team: string;
  number: number;
  title: string;
  project: string | null;
  milestone: string | null;
  assignee: string | null;
  state: StateKey;
  priority: Priority;
  /** Days ago the issue was created. */
  created: number;
  /** Days ago it entered its current state (drives "stalled"). */
  changed: number;
}

export function spec(
  team: string,
  number: number,
  title: string,
  project: string | null,
  milestone: string | null,
  assignee: string | null,
  state: StateKey,
  priority: Priority,
  created: number,
  changed: number
): IssueSpec {
  return {
    team,
    number,
    title,
    project,
    milestone,
    assignee,
    state,
    priority,
    created,
    changed,
  };
}

const STATE_TYPE_BY_KEY: ReadonlyMap<StateKey, WorkflowStateType> = new Map(
  STATE_DEFS.map((def) => [def.key, def.type])
);

/**
 * Turns a spec into an Issue with lifecycle timestamps consistent with its
 * state: started issues started when they last changed, completed ones were
 * started a day earlier, canceled ones never started. `baseUrl` is the
 * workspace's Linear URL (`https://linear.app/<urlKey>`).
 */
export function buildIssue(
  today: IsoDate,
  s: IssueSpec,
  baseUrl: string
): Issue {
  const identifier = `${s.team.toUpperCase()}-${s.number}`;
  const createdAt = daysAgo(today, s.created);
  const changedAt = daysAgo(today, s.changed, '10:00:00.000');
  const dayBeforeChange = daysAgo(
    today,
    Math.min(s.changed + 1, s.created),
    '11:00:00.000'
  );
  const type = STATE_TYPE_BY_KEY.get(s.state) ?? 'backlog';
  return {
    id: issueId(s.team, s.number),
    identifier,
    title: s.title,
    url: `${baseUrl}/issue/${identifier}/${slugify(s.title)}`,
    teamId: `team-${s.team}`,
    projectId: s.project === null ? null : projectId(s.project),
    milestoneId: s.milestone,
    assigneeId: s.assignee,
    stateId: stateId(s.team, s.state),
    priority: s.priority,
    createdAt,
    updatedAt: daysAgo(today, s.changed, '12:00:00.000'),
    startedAt:
      type === 'started'
        ? s.state === 'review'
          ? dayBeforeChange
          : changedAt
        : type === 'completed'
          ? dayBeforeChange
          : null,
    completedAt: type === 'completed' ? changedAt : null,
    canceledAt: type === 'canceled' ? changedAt : null,
    lastStateChangeAt: changedAt,
  };
}
