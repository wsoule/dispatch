// The showcase demo workspace (LINEAR_FIXTURE=showcase): the base Northwind
// Labs workspace (fixture.ts, LINEAR_FIXTURE=1) grown into a mid-size
// product company, so every graph level, its Mermaid export, the timeline,
// Projects and My week look full. Fictional and deterministic like the
// base: every date is relative to `today`, and the same `today` gives
// deep-equal data (no randomness; timestamps the tables leave out come
// from a hash of the issue's identifier).
//
// It contains the base workspace unchanged (every base user, team, state,
// initiative, project, milestone, issue, relation, label, comment and
// "done means…" row; the base teams only gain members), so each base
// scenario still exists, the same people sign in and Gus Hart is still the
// one guest (Operations only). On top: 12 people, 2 teams (Data, Growth),
// 2 initiatives, 12 projects, about 50 milestones, about 370 issues and
// about 250 blocking relations: a 13-issue critical path, fan-in and
// fan-out hubs, three designed cycles (the base one included) and plenty
// of unlinked work. The tables live in showcase-data.ts.
//
// The store and gateway are the base ones (createFixtureGateway works on
// any FixtureStore), so demo writes behave exactly as in the base demo.

import {
  type BlockingRelation,
  estimateOptions,
  type Initiative,
  type IsoDate,
  type Issue,
  type Milestone,
  type Priority,
  type Project,
  type Team,
  type WorkspaceData,
} from '@dispatch/planning';

import {
  createFixtureIssueDetails,
  type FixtureComment,
  type FixtureIssueDetails,
  type FixtureIssueFields,
} from './fixture-details.js';
import {
  addDays,
  buildIssue,
  buildStates,
  issueId,
  type IssueSpec,
  person,
  projectId,
  slugify,
  type StateKey,
  STATUS_NAME,
} from './fixture-kit.js';
import {
  createFixtureStore,
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
  FIXTURE_WORKSPACE,
  type FixtureStore,
} from './fixture.js';
import {
  ISSUE_TABLE,
  MILESTONE_TABLE,
  RELATION_TABLE,
  SHOWCASE_COMMENTS,
  SHOWCASE_DESCRIPTIONS,
  SHOWCASE_ESTIMATE_SCALES,
  SHOWCASE_EXTRA_MEMBERS,
  SHOWCASE_INITIATIVES,
  SHOWCASE_LABELS,
  SHOWCASE_PEOPLE,
  SHOWCASE_PROJECTS,
  SHOWCASE_TEAMS,
  SHOWCASE_WEIGHTS,
} from './showcase-data.js';

const BASE_URL = `https://linear.app/${FIXTURE_WORKSPACE.urlKey}`;

/** Every team of the showcase, by lowercase key, in workflow order. */
const SHOWCASE_TEAM_KEYS: readonly string[] = ['eng', 'ops', 'data', 'gro'];

/**
 * The longest blocking chain, by identifier: the enterprise launch, from
 * the v3 auth endpoints to the help center's enterprise section. Every
 * issue on it is open; ENG-187 is unassigned, so the chain after it is a
 * risk chain. A mid-path issue (ENG-240) makes a good `?chain=` demo.
 */
export const SHOWCASE_CRITICAL_PATH: readonly string[] = [
  'ENG-60',
  'ENG-186',
  'ENG-187',
  'ENG-194',
  'ENG-196',
  'ENG-240',
  'ENG-242',
  'ENG-225',
  'GRO-31',
  'GRO-33',
  'GRO-40',
  'GRO-41',
  'OPS-106',
];

/**
 * The only blocking cycles, by identifier (each sorted): the base
 * workspace's colour tokens and type scale, permission events and audit
 * across Nettle and Marble, and the failover drill and its runbook across
 * Ridge and Thistle (all Operations issues, so the guest sees it too).
 */
export const SHOWCASE_CYCLES: readonly (readonly string[])[] = [
  ['ENG-70', 'ENG-71'],
  ['ENG-215', 'ENG-243', 'ENG-244'],
  ['OPS-55', 'OPS-73'],
];

// ---------------------------------------------------------------------------
// Table parsing (once, at module load; a bad row throws)
// ---------------------------------------------------------------------------

type Timing = 'done' | 'live' | 'stalled';

interface MilestoneRow {
  key: string;
  id: string;
  project: string;
  due: number | null;
  timing: Timing;
  source: 'meta' | 'desc' | 'none';
  name: string;
  text: string;
}

interface IssueRow {
  identifier: string;
  team: string;
  number: number;
  /** Project key, or null for no project. */
  project: string | null;
  /** The milestone's id (a showcase or a base milestone), or null. */
  milestoneId: string | null;
  /** The showcase milestone's row (timing and due date); null for none
      or a base milestone, which reads as live work. */
  milestone: MilestoneRow | null;
  assigneeId: string | null;
  state: StateKey;
  priority: Priority;
  title: string;
}

const STATE_CODES: Readonly<Record<string, StateKey>> = {
  tr: 'triage',
  bl: 'backlog',
  td: 'todo',
  ip: 'progress',
  rv: 'review',
  dn: 'done',
  cx: 'canceled',
  du: 'duplicate',
};

// The table's data lines: comments and blank lines dropped, trimmed.
function tableLines(table: string): string[] {
  return table
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function fail(message: string): never {
  throw new Error(`showcase: ${message}`);
}

function parseMilestones(): MilestoneRow[] {
  return tableLines(MILESTONE_TABLE).map((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    const [key = '', due = '', timing = '', source = '', name = '', text = ''] =
      cells;
    if (cells.length !== 6) fail(`milestone row needs 6 cells: ${line}`);
    const project = key.replace(/-\d+$/, '');
    if (project === key) fail(`milestone key needs a number: ${key}`);
    if (timing !== 'done' && timing !== 'live' && timing !== 'stalled') {
      fail(`unknown milestone timing ${timing}`);
    }
    if (source !== 'meta' && source !== 'desc' && source !== 'none') {
      fail(`unknown done-means source ${source}`);
    }
    if (due !== '-' && !/^-?\d+$/.test(due)) fail(`bad due ${due}`);
    return {
      key,
      id: `ms-${key}`,
      project,
      due: due === '-' ? null : Number(due),
      timing,
      source,
      name,
      text,
    };
  });
}

const MILESTONE_ROWS: readonly MilestoneRow[] = parseMilestones();
const MILESTONE_BY_KEY: ReadonlyMap<string, MilestoneRow> = new Map(
  MILESTONE_ROWS.map((row) => [row.key, row])
);

function parseIssues(): IssueRow[] {
  return tableLines(ISSUE_TABLE).map((line) => {
    const [identifier = '', where = '', who = '', code = '', p = '', ...rest] =
      line.split(/\s+/);
    const match = /^([A-Z]+)-(\d+)$/.exec(identifier);
    if (match === null) fail(`bad identifier ${identifier}`);
    const state = STATE_CODES[code];
    if (state === undefined) fail(`unknown state ${code} on ${identifier}`);
    if (!/^[0-4]$/.test(p)) fail(`bad priority ${p} on ${identifier}`);
    let project: string | null = null;
    let milestone: MilestoneRow | null = null;
    let milestoneId: string | null = null;
    if (where.endsWith(':')) {
      project = where.slice(0, -1);
    } else if (where !== '-') {
      // A showcase milestone, or a base one ("atlas-3") by the same key.
      milestone = MILESTONE_BY_KEY.get(where) ?? null;
      project = milestone?.project ?? where.replace(/-\d+$/, '');
      if (project === where) fail(`unknown milestone ${where}`);
      milestoneId = `ms-${where}`;
    }
    return {
      identifier,
      team: (match[1] ?? '').toLowerCase(),
      number: Number(match[2]),
      project,
      milestoneId,
      milestone,
      assigneeId: who === '-' ? null : `user-${who}`,
      state,
      priority: Number(p) as Priority,
      title: rest.join(' '),
    };
  });
}

const ISSUE_ROWS: readonly IssueRow[] = parseIssues();

// Each `A > B > C` line as its consecutive (blocker, blocked) pairs.
function parseRelations(): [string, string][] {
  const pairs: [string, string][] = [];
  for (const line of tableLines(RELATION_TABLE)) {
    const ends = line.split('>').map((end) => end.trim());
    if (ends.length < 2) fail(`relation row needs "A > B": ${line}`);
    for (let i = 0; i + 1 < ends.length; i++) {
      pairs.push([ends[i] ?? '', ends[i + 1] ?? '']);
    }
  }
  return pairs;
}

const RELATION_PAIRS: readonly [string, string][] = parseRelations();

// ---------------------------------------------------------------------------
// Deterministic timing
// ---------------------------------------------------------------------------

// FNV-1a over a string: a stable 32-bit hash, so derived values depend on
// the issue's identifier only (never on row order or the clock).
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

// An integer in [lo, hi] picked by the hash of `key` and `salt`.
function pick(key: string, salt: string, lo: number, hi: number): number {
  return lo + (hash(`${key}:${salt}`) % (hi - lo + 1));
}

/**
 * Created and changed days ago for an issue (rows give no timestamps): closed
 * issues of a past milestone finished before its due date; in a stalled
 * milestone nothing moved for 9+ days; otherwise started work moved in the
 * last few days, unstarted work sat since it was filed. Changed is at least
 * a day ago, so nothing is dated today or later.
 */
function deriveTiming(row: IssueRow): [number, number] {
  const id = row.identifier;
  const timing = row.milestone?.timing ?? 'live';
  const due = row.milestone?.due ?? null;
  const closed =
    row.state === 'done' ||
    row.state === 'canceled' ||
    row.state === 'duplicate';
  let changed: number;
  let age: number;
  if (timing === 'done' && closed && due !== null && due < 0) {
    changed = pick(id, 'changed', -due + 1, -due + 8);
    age = pick(id, 'age', 5, 18);
  } else if (timing === 'stalled') {
    if (row.state === 'backlog' || row.state === 'triage') {
      changed = pick(id, 'changed', 10, 30);
      age = 0;
    } else {
      changed = pick(id, 'changed', 9, 16);
      age = pick(id, 'age', 4, 15);
    }
  } else {
    switch (row.state) {
      case 'done':
        changed = pick(id, 'changed', 2, 12);
        age = pick(id, 'age', 4, 20);
        break;
      case 'canceled':
      case 'duplicate':
        changed = pick(id, 'changed', 2, 15);
        age = pick(id, 'age', 2, 10);
        break;
      case 'progress':
        changed = pick(id, 'changed', 1, 5);
        age = pick(id, 'age', 3, 20);
        break;
      case 'review':
        changed = pick(id, 'changed', 1, 3);
        age = pick(id, 'age', 5, 20);
        break;
      case 'todo':
        changed = pick(id, 'changed', 1, 9);
        age = pick(id, 'age', 0, 12);
        break;
      case 'triage':
        changed = pick(id, 'changed', 1, 4);
        age = 0;
        break;
      case 'backlog':
        changed = pick(id, 'changed', 3, 30);
        age = 0;
        break;
      default: {
        const unreachable: never = row.state;
        return unreachable;
      }
    }
  }
  return [changed + age, changed];
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

function buildTeams(base: readonly Team[]): Team[] {
  const grown = base.map((team) => ({
    ...team,
    memberIds: [
      ...(team.memberIds ?? []),
      ...(SHOWCASE_EXTRA_MEMBERS[team.id] ?? []),
    ],
  }));
  const added: Team[] = SHOWCASE_TEAMS.map((team) => ({
    id: `team-${team.key}`,
    key: team.key.toUpperCase(),
    name: team.name,
    visibility: 'public',
    parentId: null,
    memberIds: [...team.memberIds],
  }));
  return [...grown, ...added];
}

function buildInitiatives(today: IsoDate): Initiative[] {
  return SHOWCASE_INITIATIVES.map((spec) => ({
    id: spec.id,
    name: spec.name,
    sortOrder: spec.sortOrder,
    priority: spec.priority,
    targetDate: addDays(today, spec.target),
  }));
}

function buildProjects(today: IsoDate, baseCount: number): Project[] {
  return SHOWCASE_PROJECTS.map((spec, index) => ({
    id: projectId(spec.key),
    name: spec.name,
    url: `${BASE_URL}/project/${slugify(spec.name)}`,
    leadId: spec.leadId,
    priority: spec.priority,
    sortOrder: baseCount + index + 1,
    statusType: spec.status,
    statusName: STATUS_NAME[spec.status],
    initiativeIds: [...spec.initiativeIds],
    teamIds: spec.teams.map((team) => `team-${team}`),
    startDate: spec.start === null ? null : addDays(today, spec.start),
    targetDate: spec.target === null ? null : addDays(today, spec.target),
  }));
}

// The milestone's Linear description: "Done means: …" for `desc`, the
// plain text for `none`, nothing for `meta` (the planner holds it).
function milestoneDescription(row: MilestoneRow): string | null {
  switch (row.source) {
    case 'desc':
      return `Done means: ${row.text}`;
    case 'none':
      return row.text === '' ? null : row.text;
    case 'meta':
      return null;
    default: {
      const unreachable: never = row.source;
      return unreachable;
    }
  }
}

function buildMilestones(
  today: IsoDate,
  base: readonly Milestone[]
): Milestone[] {
  const orderInProject = new Map<string, number>();
  for (const milestone of base) {
    const count = orderInProject.get(milestone.projectId) ?? 0;
    orderInProject.set(milestone.projectId, count + 1);
  }
  return MILESTONE_ROWS.map((row) => {
    const project = projectId(row.project);
    const order = (orderInProject.get(project) ?? 0) + 1;
    orderInProject.set(project, order);
    return {
      id: row.id,
      projectId: project,
      name: row.name,
      description: milestoneDescription(row),
      targetDate: row.due === null ? null : addDays(today, row.due),
      sortOrder: order,
    };
  });
}

function issueSpecOf(row: IssueRow): IssueSpec {
  const [created, changed] = deriveTiming(row);
  return {
    team: row.team,
    number: row.number,
    title: row.title,
    project: row.project,
    milestone: row.milestoneId,
    assignee: row.assigneeId,
    state: row.state,
    priority: row.priority,
    created,
    changed,
  };
}

// Throws unless every reference of the grown workspace resolves the way
// Linear would allow: known users, projects, milestones of the issue's
// project, the issue's team among its project's teams, open issues only
// without a project, unique ids and relations between known issues.
function checkReferences(data: WorkspaceData): void {
  const users = new Set(data.users.map((u) => u.id));
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const milestones = new Map(data.milestones.map((m) => [m.id, m]));
  const states = new Map(data.states.map((s) => [s.id, s]));
  const issues = new Set<string>();
  for (const issue of data.issues) {
    if (issues.has(issue.id)) fail(`duplicate issue ${issue.identifier}`);
    issues.add(issue.id);
    if (issue.assigneeId !== null && !users.has(issue.assigneeId)) {
      fail(`unknown assignee ${issue.assigneeId} on ${issue.identifier}`);
    }
    if (!states.has(issue.stateId))
      fail(`unknown state on ${issue.identifier}`);
    if (issue.projectId === null) {
      const type = states.get(issue.stateId)?.type;
      if (type === 'completed' || type === 'canceled') {
        fail(`${issue.identifier} has no project, so it must be open`);
      }
      continue;
    }
    const project = projects.get(issue.projectId);
    if (project === undefined) fail(`unknown project on ${issue.identifier}`);
    if (!project.teamIds.includes(issue.teamId)) {
      fail(`${issue.identifier}'s team is not in ${project.id}`);
    }
    if (issue.milestoneId !== null) {
      const milestone = milestones.get(issue.milestoneId);
      if (milestone?.projectId !== project.id) {
        fail(`${issue.identifier}'s milestone is not in its project`);
      }
    }
  }
  const pairs = new Set<string>();
  for (const relation of data.relations) {
    const pair = `${relation.blockerId}>${relation.blockedId}`;
    if (!issues.has(relation.blockerId) || !issues.has(relation.blockedId)) {
      fail(`relation ${pair} names an unknown issue`);
    }
    if (relation.blockerId === relation.blockedId || pairs.has(pair)) {
      fail(`relation ${pair} is a self or repeated relation`);
    }
    pairs.add(pair);
  }
  for (const project of data.projects) {
    if (project.leadId !== null && !users.has(project.leadId)) {
      fail(`unknown lead on ${project.id}`);
    }
  }
}

// An identifier ("ENG-12") as its issue id ("iss-eng-12").
function idOf(identifier: string): string {
  const match = /^([A-Z]+)-(\d+)$/.exec(identifier);
  if (match === null) fail(`bad identifier ${identifier}`);
  return issueId((match[1] ?? '').toLowerCase(), Number(match[2]));
}

/**
 * The showcase workspace with every date relative to `today`.
 * Deterministic: two calls with the same `today` return deep-equal data.
 * Contains createFixtureWorkspace(today) unchanged, entity by entity.
 */
export function createShowcaseWorkspace(today: IsoDate): WorkspaceData {
  const base = createFixtureWorkspace(today);
  const relations: BlockingRelation[] = [
    ...base.relations,
    ...RELATION_PAIRS.map(([blocker, blocked], index) => ({
      id: `rel-sc-${index + 1}`,
      blockerId: idOf(blocker),
      blockedId: idOf(blocked),
    })),
  ];
  const issues: Issue[] = [
    ...base.issues,
    ...ISSUE_ROWS.map((row) => buildIssue(today, issueSpecOf(row), BASE_URL)),
  ];
  const data: WorkspaceData = {
    workspaceId: base.workspaceId,
    users: [
      ...base.users,
      ...SHOWCASE_PEOPLE.map((entry) => person(entry.id, entry.name)),
    ],
    teams: buildTeams(base.teams),
    states: buildStates(SHOWCASE_TEAM_KEYS),
    initiatives: [...base.initiatives, ...buildInitiatives(today)],
    projects: [...base.projects, ...buildProjects(today, base.projects.length)],
    milestones: [
      ...base.milestones,
      ...buildMilestones(today, base.milestones),
    ],
    issues,
    relations,
  };
  checkReferences(data);
  return data;
}

/**
 * Tool-owned data demo mode seeds for the showcase: the base rows
 * (FIXTURE_MILESTONE_META) plus "done means…" for every new milestone
 * whose table row says `meta`, and two more weight overrides. Willow's
 * next milestone (willow-1) is left without one on purpose (missing
 * inputs), like the base workspace's ms-harbor-1.
 */
export const SHOWCASE_MILESTONE_META: {
  milestoneId: string;
  doneMeans: string | null;
  weight: number | null;
}[] = [
  ...FIXTURE_MILESTONE_META.map((row) => ({ ...row })),
  ...MILESTONE_ROWS.filter(
    (row) => row.source === 'meta' || SHOWCASE_WEIGHTS[row.id] !== undefined
  ).map((row) => ({
    milestoneId: row.id,
    doneMeans: row.source === 'meta' ? row.text : null,
    weight: SHOWCASE_WEIGHTS[row.id] ?? null,
  })),
];

// ---------------------------------------------------------------------------
// Issue page content
// ---------------------------------------------------------------------------

// Labels a new issue carries, from its team and title: one workspace kind
// (customer request, bug, feature or improvement) and its team's labels
// (Engineering: one Area plus Performance; Operations, Data and Growth
// their own), all valid for the issue's team as the gateway checks them.
function labelsFor(row: IssueRow): string[] {
  const title = row.title;
  const labels: string[] = [];
  if (/^Request:/.test(title)) labels.push('lbl-customer');
  else if (/^(Fix|Flaky)\b|crash/i.test(title)) labels.push('lbl-bug');
  else if (hash(`${row.identifier}:kind`) % 10 < 7) labels.push('lbl-feature');
  else labels.push('lbl-improvement');
  if (/SSO|SAML|SCIM|OIDC|penetration|security/i.test(title)) {
    labels.push('lbl-security');
  }
  switch (row.team) {
    case 'eng':
      if (row.project === 'garnet' || /mobile|tablet/i.test(title)) {
        labels.push('lbl-eng-mobile');
      } else if (
        /page|form|panel|editor|wizard|badge|bar|button|states|picker|layout|component|site|examples|navigation|viewer|console|guide|guidelines|notes|copy/i.test(
          title
        )
      ) {
        labels.push('lbl-eng-frontend');
      } else {
        labels.push('lbl-eng-backend');
      }
      if (/cache|latency|load|performance|batching/i.test(title)) {
        labels.push('lbl-eng-performance');
      }
      break;
    case 'ops':
      if (
        /region|network|VPN|backup|DNS|capacity|failover|gateway|pager/i.test(
          title
        )
      ) {
        labels.push('lbl-ops-infra');
      } else if (/laptop|badge reader|vendor|contract/i.test(title)) {
        labels.push('lbl-ops-vendor');
      } else {
        labels.push('lbl-ops-process');
      }
      break;
    case 'data':
      labels.push(
        /event|load|ingest|stream|replay|backfill|partition|queue|producer|schema|pipeline|writes/i.test(
          title
        )
          ? 'lbl-data-pipeline'
          : 'lbl-data-modeling'
      );
      break;
    case 'gro':
      if (/email|nudge|onboarding|welcome|reminder/i.test(title)) {
        labels.push('lbl-gro-lifecycle');
      } else if (/A\/B|experiment|research|interview/i.test(title)) {
        labels.push('lbl-gro-experiment');
      }
      break;
    default:
      break;
  }
  return labels;
}

/**
 * How a new showcase issue gets a due date, by where its milestone's
 * target stands against `today`: `share` is the part of the issues of
 * the kind that carry one (picked by the identifier's hash), `lead` the
 * most days before the target it falls, and `floorToday` keeps open work
 * in a milestone that is not yet overdue from being overdue itself. Open
 * work in an overdue milestone is overdue too, so only some of it is
 * dated; most open work rides on its milestone alone.
 */
const DUE_RULES: Readonly<
  Record<
    'closed' | 'overdue' | 'soon' | 'weeks' | 'later' | 'none',
    { share: number; lead: number; floorToday: boolean }
  >
> = {
  // Done work keeps the date it was due by (on or before its milestone's).
  closed: { share: 0.2, lead: 4, floorToday: false },
  // Open work in a milestone past its target: overdue.
  overdue: { share: 0.5, lead: 3, floorToday: false },
  // Open work in a milestone due within two days: mostly today or tomorrow.
  soon: { share: 0.65, lead: 2, floorToday: true },
  // Open work in a milestone due in 3 to 14 days.
  weeks: { share: 0.33, lead: 5, floorToday: true },
  // Open work in a milestone further out.
  later: { share: 0.25, lead: 7, floorToday: true },
  // Open work with no milestone date: a date of its own, 4 to 25 days out.
  none: { share: 0.17, lead: 0, floorToday: true },
};

/**
 * A new showcase issue's due date for `today`, or null: about a quarter
 * of the showcase's issues carry one (DUE_RULES), never after its
 * milestone's target and never before the day it was filed (an issue that
 * cannot meet both carries none); canceled and duplicate issues carry
 * none. `target` is the milestone's target date (a showcase or a base
 * milestone), or null.
 */
function showcaseDueDate(
  row: IssueRow,
  target: IsoDate | null,
  today: IsoDate
): IsoDate | null {
  if (row.state === 'canceled' || row.state === 'duplicate') return null;
  const id = row.identifier;
  const closed = row.state === 'done';
  if (closed && target === null) return null;
  const kind = closed
    ? 'closed'
    : target === null
      ? 'none'
      : target < today
        ? 'overdue'
        : target <= addDays(today, 2)
          ? 'soon'
          : target <= addDays(today, 14)
            ? 'weeks'
            : 'later';
  const rule = DUE_RULES[kind];
  if (hash(`${id}:due?`) % 100 >= rule.share * 100) return null;
  let due =
    target === null
      ? addDays(today, pick(id, 'due', 4, 25))
      : addDays(target, -pick(id, 'due', 0, rule.lead));
  if (rule.floorToday && due < today) due = today;
  const filed = addDays(today, -deriveTiming(row)[0]);
  if (due < filed) {
    if (target !== null && filed > target) return null;
    due = filed;
  }
  return due;
}

/**
 * The showcase's issue-page content for `today`: the base content
 * (createFixtureIssueDetails) plus fields for every new issue (labels from
 * its title, an estimate on its team's scale for most, a due date for
 * about a quarter (showcaseDueDate), descriptions on the issues the story
 * runs through), the new teams' labels and scales, and a seeded
 * discussion on the critical path, the hubs and the cycles.
 */
export function createShowcaseIssueDetails(
  today: IsoDate
): FixtureIssueDetails {
  const base = createFixtureIssueDetails(today);
  const estimateScales = {
    ...base.estimateScales,
    ...Object.fromEntries(
      Object.entries(SHOWCASE_ESTIMATE_SCALES).map(([teamId, scale]) => [
        teamId,
        { ...scale },
      ])
    ),
  };
  const issueFields: Record<string, FixtureIssueFields> = {
    ...base.issueFields,
  };
  // A base milestone's target, for the new issues planned into it.
  const baseTargets = new Map(
    createFixtureWorkspace(today).milestones.map((m) => [m.id, m.targetDate])
  );
  for (const row of ISSUE_ROWS) {
    const id = idOf(row.identifier);
    const scale = estimateScales[`team-${row.team}`];
    const options = scale === undefined ? [] : estimateOptions(scale);
    const estimated =
      row.state !== 'triage' &&
      options.length > 0 &&
      hash(`${row.identifier}:estimate?`) % 6 !== 0;
    const target =
      row.milestone !== null
        ? row.milestone.due === null
          ? null
          : addDays(today, row.milestone.due)
        : row.milestoneId === null
          ? null
          : (baseTargets.get(row.milestoneId) ?? null);
    issueFields[id] = {
      description: SHOWCASE_DESCRIPTIONS[row.identifier] ?? null,
      labelIds: labelsFor(row),
      estimate: estimated
        ? (options[
            hash(`${row.identifier}:estimate`) % Math.min(options.length, 4)
          ]?.value ?? null)
        : null,
      dueDate: showcaseDueDate(row, target, today),
    };
  }
  const first = base.seededComments.length;
  const seededComments: FixtureComment[] = [
    ...base.seededComments,
    ...SHOWCASE_COMMENTS.map((spec, index) => {
      const hour = String(spec.hour).padStart(2, '0');
      const comment: FixtureComment = {
        id: `seed-comment-${first + index + 1}`,
        issueId: idOf(spec.issue),
        body: spec.body,
        authorId: spec.authorId,
        createdAt: `${addDays(today, -spec.daysAgo)}T${hour}:00:00.000Z`,
      };
      if (spec.replyTo !== undefined) {
        comment.parentId = `seed-comment-${first + spec.replyTo + 1}`;
      }
      return comment;
    }),
  ];
  return {
    issueFields,
    labels: [...base.labels, ...SHOWCASE_LABELS.map((entry) => ({ ...entry }))],
    estimateScales,
    seededComments,
  };
}

/**
 * A fresh store over a fresh showcase workspace (stores never share data),
 * served by createFixtureGateway like the base store.
 */
export function createShowcaseStore(today: IsoDate): FixtureStore {
  const details = createShowcaseIssueDetails(today);
  const data = createShowcaseWorkspace(today);
  return {
    data,
    comments: [],
    now: () => new Date(),
    seededComments: details.seededComments,
    issueFields: details.issueFields,
    labels: details.labels,
    estimateScales: details.estimateScales,
    // Seeded relation ids are named (rel-…, rel-sc-…), so the first one a
    // person adds is rel-<seeded count + 1>, as in the base store.
    lastRelationNumber: data.relations.length,
  };
}

// ---------------------------------------------------------------------------
// Choosing a demo workspace
// ---------------------------------------------------------------------------

/**
 * Which demo workspace demo mode serves: `base` (LINEAR_FIXTURE=1, the
 * scenario fixture every test pins) or `showcase` (LINEAR_FIXTURE=showcase,
 * the large workspace for live demos).
 */
export type FixtureDataset = 'base' | 'showcase';

/** A fresh store over the chosen demo workspace for `today`. */
export function createDemoStore(
  today: IsoDate,
  dataset: FixtureDataset
): FixtureStore {
  return dataset === 'showcase'
    ? createShowcaseStore(today)
    : createFixtureStore(today);
}

/** The "done means…" and weight rows demo mode seeds for a workspace. */
export function demoMilestoneMeta(
  dataset: FixtureDataset
): typeof FIXTURE_MILESTONE_META {
  return dataset === 'showcase'
    ? SHOWCASE_MILESTONE_META
    : FIXTURE_MILESTONE_META;
}
