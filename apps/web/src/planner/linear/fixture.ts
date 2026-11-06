// The demo workspace ("Northwind Labs") used by demo mode and by tests in
// other packages. It is fictional and deterministic: every date is relative
// to the `today` passed in, so the same scenarios exist whenever it runs.
//
// It deliberately covers every case the planner handles (see the project
// table below and test/fixture.test.ts, which pins each scenario down):
// overdue / at risk for each reason / on track / complete / empty /
// undated milestones, an invalid next milestone, projects without a lead or
// with a deactivated lead, a paused project, triage and unplanned issues,
// a cross-project blocks chain, a cycle and a resolved blocker.
//
// createFixtureGateway serves the workspace through the LinearGateway
// interface and applies every write to it, so demo-mode allocation runs,
// milestone, lead and issue edits "write back". The issue page's extra
// fields (descriptions, labels, estimates, due dates, comments) live in
// fixture-details.ts and are kept in the same in-memory store. The generic
// builders (dates, people, workflow states, the issue builder) are in
// fixture-kit.ts, shared with the larger showcase workspace (showcase.ts,
// LINEAR_FIXTURE=showcase), which contains this workspace unchanged.

import {
  type BlockingRelation,
  type EstimateScale,
  type Initiative,
  isAllowedEstimate,
  type IsoDate,
  type IsoDateTime,
  type Issue,
  type IssueComment,
  type IssueExtras,
  type IssueLabel,
  type IssuePatch,
  type Milestone,
  type Priority,
  type Project,
  type ProjectStatusType,
  type Team,
  type User,
  type WorkflowState,
  type WorkspaceData,
} from '@dispatch/planning';

import {
  createFixtureIssueDetails,
  type FixtureComment,
  type FixtureIssueFields,
  type FixtureLabel,
} from './fixture-details.js';
import {
  addDays,
  buildIssue,
  buildStates,
  type IssueSpec,
  person,
  projectId,
  slugify,
  spec,
  STATUS_NAME,
} from './fixture-kit.js';
import {
  LinearApiError,
  type LinearGateway,
  type LinearIdentity,
} from './gateway.js';
import { NO_ESTIMATES } from './map.js';

// ---------------------------------------------------------------------------
// Identity constants
// ---------------------------------------------------------------------------

export const FIXTURE_WORKSPACE: { id: string; name: string; urlKey: string } = {
  id: 'org-northwind',
  name: 'Northwind Labs',
  urlKey: 'northwind',
};

/** The tool's own app user (what actor=app tokens act as). */
const FIXTURE_APP_USER_ID = 'user-app';

/**
 * The demo workspace's one Linear guest, Gus Hart: a member of Operations
 * only, so he sees that team alone (§2.13), and the planner is read-only
 * for him (owner decision 2026-10-22, "Guests limited to read only"). He
 * is in the demo picker so the read-only planner can be tried.
 */
export const FIXTURE_GUEST_USER_ID = 'user-gus';

const BASE_URL = `https://linear.app/${FIXTURE_WORKSPACE.urlKey}`;

// ---------------------------------------------------------------------------
// People, teams, states, initiatives
// ---------------------------------------------------------------------------

function buildUsers(): User[] {
  return [
    person('user-ana', 'Ana Moreno'),
    person('user-ben', 'Ben Carter'),
    person('user-chloe', 'Chloe Diaz'),
    person('user-dev', 'Dev Patel'),
    person('user-elena', 'Elena Novak'),
    person('user-femi', 'Femi Adeyemi'),
    person('user-grace', 'Grace Lin'),
    // Deactivated, and still the lead of proj-ember (blocked/lead_inactive).
    person('user-hugo', 'Hugo Laurent', { active: false }),
    // A Linear guest in Operations only: the read-only planner.
    person(FIXTURE_GUEST_USER_ID, 'Gus Hart', { guest: true }),
    {
      id: FIXTURE_APP_USER_ID,
      name: 'Milestone Planner',
      displayName: 'milestone-planner',
      email: null,
      avatarUrl: null,
      active: true,
      app: true,
      guest: false,
    },
  ];
}

type TeamKey = 'eng' | 'ops';

// Both teams are public, so every demo person sees the whole workspace
// (per-viewer visibility, architecture §2.13) except the guest, Gus Hart,
// who sees only Operations, the one team he is a member of (and no
// initiatives); the members are who Linear lists in each team.
const TEAMS: readonly Team[] = [
  {
    id: 'team-eng',
    key: 'ENG',
    name: 'Engineering',
    visibility: 'public',
    parentId: null,
    memberIds: [
      'user-ana',
      'user-chloe',
      'user-dev',
      'user-femi',
      'user-grace',
      'user-hugo',
    ],
  },
  {
    id: 'team-ops',
    key: 'OPS',
    name: 'Operations',
    visibility: 'public',
    parentId: null,
    memberIds: [
      'user-ana',
      'user-ben',
      'user-elena',
      'user-femi',
      FIXTURE_GUEST_USER_ID,
    ],
  },
];

function buildInitiatives(today: IsoDate): Initiative[] {
  return [
    {
      id: 'init-platform',
      name: 'Platform reliability',
      sortOrder: 1,
      priority: 1,
      targetDate: addDays(today, 60),
    },
    {
      id: 'init-growth',
      name: 'Customer growth',
      sortOrder: 2,
      priority: 3,
      targetDate: addDays(today, 90),
    },
  ];
}

// ---------------------------------------------------------------------------
// Projects and milestones
// ---------------------------------------------------------------------------

interface ProjectSpec {
  key: string;
  name: string;
  status: ProjectStatusType;
  leadId: string | null;
  priority: Priority;
  initiativeIds: string[];
  teams: TeamKey[];
  /** Start date relative to today (negative = past); null = none. */
  start: number | null;
  target: number | null;
}

// The scenario table. Letters match the fixture tests.
//  (a) atlas   started, overdue next milestone with unassigned issues,
//              later milestone whose description says "Done means: …",
//              plus (i) a complete milestone in the past
//  (b) beacon  next milestone due in 2 days, 3/7 done: behind pace
//  (c) compass planned, due in 5 days with unassigned Backlog/Todo issues
//              and a triage issue; an undated milestone
//  (d) delta   no lead                     → blocked/no_lead
//  (e) ember   lead deactivated            → blocked/lead_inactive
//  (f) fjord   paused                      → inactive
//  (g) garnet  no initiative, due in 6 days, fully assigned, stalled;
//              a later empty milestone; unplanned issues
//  (h) harbor  due in 4 days, no "done means" anywhere → invalid
//  (j) juniper on-track milestones further out (weight override, a cycle)
const PROJECT_SPECS: readonly ProjectSpec[] = [
  {
    key: 'atlas',
    name: 'Atlas billing migration',
    status: 'started',
    leadId: 'user-chloe',
    priority: 1,
    initiativeIds: ['init-platform'],
    teams: ['eng'],
    start: -45,
    target: 30,
  },
  {
    key: 'beacon',
    name: 'Beacon search',
    status: 'started',
    leadId: 'user-dev',
    priority: 2,
    initiativeIds: ['init-growth'],
    teams: ['eng'],
    start: -30,
    target: 35,
  },
  {
    key: 'compass',
    name: 'Compass onboarding',
    status: 'planned',
    leadId: 'user-ana',
    priority: 2,
    initiativeIds: ['init-growth'],
    teams: ['eng', 'ops'],
    start: 0,
    target: 45,
  },
  {
    key: 'delta',
    name: 'Delta exports',
    status: 'started',
    leadId: null,
    priority: 3,
    initiativeIds: ['init-platform'],
    teams: ['ops'],
    start: -20,
    target: 20,
  },
  {
    key: 'ember',
    name: 'Ember notifications',
    status: 'started',
    leadId: 'user-hugo',
    priority: 3,
    initiativeIds: ['init-growth'],
    teams: ['eng'],
    start: -25,
    target: 15,
  },
  {
    key: 'fjord',
    name: 'Fjord analytics',
    status: 'paused',
    leadId: 'user-femi',
    priority: 4,
    initiativeIds: ['init-platform'],
    teams: ['ops'],
    start: -60,
    target: null,
  },
  {
    key: 'garnet',
    name: 'Garnet mobile app',
    status: 'started',
    leadId: 'user-ben',
    priority: 2,
    initiativeIds: [],
    teams: ['eng'],
    start: -40,
    target: 25,
  },
  {
    key: 'harbor',
    name: 'Harbor API v3',
    status: 'started',
    leadId: 'user-elena',
    priority: 1,
    initiativeIds: ['init-platform'],
    teams: ['eng'],
    start: -15,
    target: 30,
  },
  {
    key: 'juniper',
    name: 'Juniper design system',
    status: 'started',
    leadId: 'user-grace',
    priority: 0,
    initiativeIds: ['init-growth', 'init-platform'],
    teams: ['eng', 'ops'],
    start: -10,
    target: 40,
  },
];

function buildProjects(today: IsoDate): Project[] {
  return PROJECT_SPECS.map((spec, index) => ({
    id: projectId(spec.key),
    name: spec.name,
    url: `${BASE_URL}/project/${slugify(spec.name)}`,
    leadId: spec.leadId,
    priority: spec.priority,
    sortOrder: index + 1,
    statusType: spec.status,
    statusName: STATUS_NAME[spec.status],
    initiativeIds: [...spec.initiativeIds],
    teamIds: spec.teams.map((team) => `team-${team}`),
    startDate: spec.start === null ? null : addDays(today, spec.start),
    targetDate: spec.target === null ? null : addDays(today, spec.target),
  }));
}

interface MilestoneSpec {
  id: string;
  project: string;
  name: string;
  /** Days from today; null = undated. */
  due: number | null;
  description: string | null;
}

const MILESTONE_SPECS: readonly MilestoneSpec[] = [
  {
    id: 'ms-atlas-1',
    project: 'atlas',
    name: 'Schema cutover',
    due: -20,
    description: 'Done means: the new ledger schema is live in production.',
  },
  {
    id: 'ms-atlas-2',
    project: 'atlas',
    name: 'Dual-write',
    due: -3,
    description:
      'Write every invoice and payment to both ledgers behind a flag.',
  },
  {
    id: 'ms-atlas-3',
    project: 'atlas',
    name: 'Read path switch',
    due: 25,
    description:
      'Done means: all reads are served from the new ledger with parity checks green.\n\nRollout notes live in the project document.',
  },
  {
    id: 'ms-beacon-1',
    project: 'beacon',
    name: 'Search v2 beta',
    due: 2,
    description: null,
  },
  {
    id: 'ms-beacon-2',
    project: 'beacon',
    name: 'Search v2 GA',
    due: 30,
    description: null,
  },
  {
    id: 'ms-compass-1',
    project: 'compass',
    name: 'Guided setup',
    due: 5,
    description: 'First-run experience for new workspaces.',
  },
  {
    id: 'ms-compass-2',
    project: 'compass',
    name: 'Team invites',
    due: 40,
    description: null,
  },
  {
    id: 'ms-compass-3',
    project: 'compass',
    name: 'Localization',
    due: null,
    description: 'Translations for the setup flow; date to be set.',
  },
  {
    id: 'ms-delta-1',
    project: 'delta',
    name: 'CSV exports',
    due: 12,
    description: null,
  },
  {
    id: 'ms-ember-1',
    project: 'ember',
    name: 'Email digests',
    due: 9,
    description: null,
  },
  {
    id: 'ms-fjord-1',
    project: 'fjord',
    name: 'Dashboards',
    due: -5,
    description: null,
  },
  {
    id: 'ms-garnet-1',
    project: 'garnet',
    name: 'Offline mode',
    due: 6,
    description: null,
  },
  {
    id: 'ms-garnet-2',
    project: 'garnet',
    name: 'Push notifications',
    due: 20,
    description: 'Placeholder until the push provider is chosen.',
  },
  {
    id: 'ms-harbor-1',
    project: 'harbor',
    name: 'Public beta',
    due: 4,
    description: 'Ship the v3 endpoints to beta customers.',
  },
  {
    id: 'ms-harbor-2',
    project: 'harbor',
    name: 'General availability',
    due: 28,
    description: 'Done means: v3 is the default for every new API key.',
  },
  {
    id: 'ms-juniper-1',
    project: 'juniper',
    name: 'Tokens and type',
    due: 14,
    description: null,
  },
  {
    id: 'ms-juniper-2',
    project: 'juniper',
    name: 'Component library',
    due: 35,
    description: null,
  },
];

function buildMilestones(today: IsoDate): Milestone[] {
  const orderInProject = new Map<string, number>();
  return MILESTONE_SPECS.map((spec) => {
    const order = (orderInProject.get(spec.project) ?? 0) + 1;
    orderInProject.set(spec.project, order);
    return {
      id: spec.id,
      projectId: projectId(spec.project),
      name: spec.name,
      description: spec.description,
      targetDate: spec.due === null ? null : addDays(today, spec.due),
      sortOrder: order,
    };
  });
}

/**
 * Tool-owned data the engine seeds in demo mode: "done means…" for most
 * valid next milestones and one weight override. ms-harbor-1 is left out on
 * purpose (scenario h); ms-atlas-1/3 and ms-harbor-2 rely on their Linear
 * descriptions instead.
 */
export const FIXTURE_MILESTONE_META: {
  milestoneId: string;
  doneMeans: string | null;
  weight: number | null;
}[] = [
  {
    milestoneId: 'ms-atlas-2',
    doneMeans:
      'Every invoice and payment write lands in both ledgers with zero drift.',
    weight: null,
  },
  {
    milestoneId: 'ms-beacon-1',
    doneMeans:
      'Beta customers can search the full catalog with typo tolerance.',
    weight: null,
  },
  {
    milestoneId: 'ms-beacon-2',
    doneMeans: 'Search v2 serves all production traffic.',
    weight: null,
  },
  {
    milestoneId: 'ms-compass-1',
    doneMeans:
      'A new workspace reaches its first project in under five minutes.',
    weight: null,
  },
  {
    milestoneId: 'ms-compass-2',
    doneMeans: 'Admins can invite their team from the setup flow.',
    weight: null,
  },
  {
    milestoneId: 'ms-compass-3',
    doneMeans: 'The setup flow ships in three languages.',
    weight: null,
  },
  {
    milestoneId: 'ms-delta-1',
    doneMeans: 'Admins can export any report as CSV.',
    weight: null,
  },
  {
    milestoneId: 'ms-ember-1',
    doneMeans: 'Each user receives at most one digest email per day.',
    weight: null,
  },
  {
    milestoneId: 'ms-fjord-1',
    doneMeans: 'Usage and retention dashboards are live for every workspace.',
    weight: null,
  },
  {
    milestoneId: 'ms-garnet-1',
    doneMeans: 'The app works through a full day offline without losing data.',
    weight: null,
  },
  {
    milestoneId: 'ms-garnet-2',
    doneMeans: 'Push notifications reach iOS and Android devices.',
    weight: null,
  },
  {
    milestoneId: 'ms-juniper-1',
    doneMeans: 'Every product surface uses the shared color and type tokens.',
    weight: 5,
  },
  {
    milestoneId: 'ms-juniper-2',
    doneMeans: 'Forms and buttons come from the component library.',
    weight: null,
  },
];

// ---------------------------------------------------------------------------
// Issues and relations
// ---------------------------------------------------------------------------

const ISSUE_SPECS: readonly IssueSpec[] = [
  // (a)+(i) Atlas: ms-atlas-1 complete in the past; ms-atlas-2 overdue with
  // two unassigned open issues (one Backlog, one Todo) and a Duplicate.
  spec(
    'eng',
    1,
    'Design the ledger schema',
    'atlas',
    'ms-atlas-1',
    'user-chloe',
    'done',
    2,
    50,
    22
  ),
  spec(
    'eng',
    2,
    'Migrate the invoices table',
    'atlas',
    'ms-atlas-1',
    'user-dev',
    'done',
    2,
    48,
    21
  ),
  spec(
    'eng',
    3,
    'Backfill historical invoices',
    'atlas',
    'ms-atlas-1',
    'user-chloe',
    'canceled',
    3,
    45,
    25
  ),
  spec(
    'eng',
    10,
    'Dual-write invoices',
    'atlas',
    'ms-atlas-2',
    'user-chloe',
    'progress',
    1,
    30,
    2
  ),
  spec(
    'eng',
    11,
    'Dual-write payments',
    'atlas',
    'ms-atlas-2',
    'user-ben',
    'review',
    2,
    28,
    1
  ),
  spec(
    'eng',
    12,
    'Reconcile dual-write drift',
    'atlas',
    'ms-atlas-2',
    null,
    'backlog',
    1,
    20,
    20
  ),
  spec(
    'eng',
    13,
    'Feature flag for dual-write',
    'atlas',
    'ms-atlas-2',
    null,
    'todo',
    3,
    18,
    9
  ),
  spec(
    'eng',
    14,
    'Dual-write audit log',
    'atlas',
    'ms-atlas-2',
    null,
    'duplicate',
    4,
    15,
    8
  ),
  spec(
    'eng',
    16,
    'Read-path parity checks',
    'atlas',
    'ms-atlas-3',
    'user-chloe',
    'todo',
    2,
    10,
    5
  ),
  spec(
    'eng',
    17,
    'Switch reads to the new ledger',
    'atlas',
    'ms-atlas-3',
    null,
    'backlog',
    2,
    10,
    10
  ),
  spec(
    'eng',
    18,
    'Remove the legacy ledger',
    'atlas',
    null,
    null,
    'backlog',
    4,
    9,
    9
  ),

  // (b) Beacon: ms-beacon-1 due in 2 days, 3 of 7 done, all assigned, moving.
  spec(
    'eng',
    20,
    'Index the product catalog',
    'beacon',
    'ms-beacon-1',
    'user-dev',
    'done',
    2,
    30,
    6
  ),
  spec(
    'eng',
    21,
    'Query parser',
    'beacon',
    'ms-beacon-1',
    'user-dev',
    'done',
    2,
    29,
    4
  ),
  spec(
    'eng',
    22,
    'Ranking v2',
    'beacon',
    'ms-beacon-1',
    'user-ana',
    'done',
    1,
    28,
    3
  ),
  spec(
    'eng',
    23,
    'Typo tolerance',
    'beacon',
    'ms-beacon-1',
    'user-dev',
    'progress',
    1,
    25,
    1
  ),
  spec(
    'eng',
    24,
    'Search analytics events',
    'beacon',
    'ms-beacon-1',
    'user-ana',
    'todo',
    3,
    20,
    2
  ),
  spec(
    'eng',
    25,
    'Beta feedback widget',
    'beacon',
    'ms-beacon-1',
    'user-ben',
    'review',
    3,
    18,
    1
  ),
  spec(
    'eng',
    26,
    'Search results page polish',
    'beacon',
    'ms-beacon-1',
    'user-grace',
    'todo',
    4,
    15,
    3
  ),
  spec(
    'eng',
    27,
    'Synonyms admin',
    'beacon',
    'ms-beacon-2',
    'user-dev',
    'backlog',
    3,
    12,
    12
  ),
  spec(
    'eng',
    28,
    'Search GA launch checklist',
    'beacon',
    'ms-beacon-2',
    'user-ana',
    'backlog',
    2,
    10,
    10
  ),

  // (c) Compass: ms-compass-1 due in 5 days; unassigned Backlog (→ Todo on
  // allocation, in both teams), an unassigned Todo and a triage issue.
  spec(
    'eng',
    30,
    'Setup checklist UI',
    'compass',
    'ms-compass-1',
    'user-ana',
    'progress',
    2,
    14,
    2
  ),
  spec(
    'eng',
    31,
    'Sample data import',
    'compass',
    'ms-compass-1',
    null,
    'backlog',
    2,
    12,
    12
  ),
  spec(
    'ops',
    1,
    'Welcome email sequence',
    'compass',
    'ms-compass-1',
    null,
    'backlog',
    3,
    11,
    11
  ),
  spec(
    'eng',
    32,
    'Workspace templates',
    'compass',
    'ms-compass-1',
    null,
    'todo',
    3,
    10,
    4
  ),
  spec(
    'eng',
    33,
    'Request: SSO during setup',
    'compass',
    'ms-compass-1',
    null,
    'triage',
    0,
    3,
    3
  ),
  spec(
    'eng',
    34,
    'Setup funnel analytics',
    'compass',
    'ms-compass-1',
    'user-chloe',
    'done',
    3,
    13,
    3
  ),
  spec(
    'eng',
    35,
    'Invite flow',
    'compass',
    'ms-compass-2',
    'user-ana',
    'backlog',
    2,
    9,
    9
  ),
  spec(
    'eng',
    36,
    'Translate setup copy',
    'compass',
    'ms-compass-3',
    null,
    'backlog',
    4,
    8,
    8
  ),
  spec(
    'ops',
    2,
    'Locale QA pass',
    'compass',
    'ms-compass-3',
    'user-femi',
    'todo',
    4,
    8,
    6
  ),

  // (d) Delta: no lead.
  spec(
    'ops',
    5,
    'CSV export job',
    'delta',
    'ms-delta-1',
    null,
    'backlog',
    2,
    20,
    20
  ),
  spec(
    'ops',
    6,
    'Export permissions',
    'delta',
    'ms-delta-1',
    'user-femi',
    'progress',
    2,
    18,
    3
  ),

  // (e) Ember: lead deactivated.
  spec(
    'eng',
    40,
    'Digest email template',
    'ember',
    'ms-ember-1',
    null,
    'backlog',
    3,
    22,
    22
  ),
  spec(
    'eng',
    41,
    'Digest scheduler',
    'ember',
    'ms-ember-1',
    'user-grace',
    'progress',
    2,
    21,
    4
  ),

  // (f) Fjord: paused, so its overdue milestone is not warned about.
  spec(
    'ops',
    8,
    'Usage dashboard',
    'fjord',
    'ms-fjord-1',
    'user-femi',
    'progress',
    2,
    40,
    15
  ),
  spec(
    'ops',
    9,
    'Retention chart',
    'fjord',
    'ms-fjord-1',
    null,
    'backlog',
    3,
    38,
    38
  ),

  // (g) Garnet: ms-garnet-1 fully assigned but nothing moved for 11+ days;
  // ms-garnet-2 is empty; two open issues have no milestone (unplanned).
  spec(
    'eng',
    50,
    'Offline write queue',
    'garnet',
    'ms-garnet-1',
    'user-ben',
    'progress',
    1,
    30,
    12
  ),
  spec(
    'eng',
    51,
    'Conflict resolution rules',
    'garnet',
    'ms-garnet-1',
    'user-chloe',
    'todo',
    2,
    25,
    14
  ),
  spec(
    'eng',
    52,
    'Sync status indicator',
    'garnet',
    'ms-garnet-1',
    'user-ben',
    'done',
    3,
    25,
    11
  ),
  spec(
    'eng',
    53,
    'Offline QA plan',
    'garnet',
    'ms-garnet-1',
    'user-ana',
    'todo',
    3,
    24,
    13
  ),
  spec(
    'eng',
    54,
    'Crash on cold start',
    'garnet',
    null,
    'user-ben',
    'todo',
    1,
    6,
    5
  ),
  spec('eng', 55, 'Dark mode icons', 'garnet', null, null, 'backlog', 4, 7, 7),

  // (h) Harbor: ms-harbor-1 due in 4 days with no "done means".
  spec(
    'eng',
    60,
    'v3 auth endpoints',
    'harbor',
    'ms-harbor-1',
    'user-elena',
    'progress',
    1,
    16,
    1
  ),
  spec(
    'eng',
    61,
    'Rate limit headers',
    'harbor',
    'ms-harbor-1',
    null,
    'backlog',
    2,
    14,
    14
  ),
  spec(
    'eng',
    62,
    'v3 API reference docs',
    'harbor',
    'ms-harbor-1',
    'user-ben',
    'todo',
    3,
    12,
    2
  ),
  spec(
    'eng',
    63,
    'Deprecate v2 keys',
    'harbor',
    'ms-harbor-2',
    'user-elena',
    'backlog',
    3,
    10,
    10
  ),

  // (j) Juniper: on track further out; ENG-70 and ENG-71 block each other.
  spec(
    'eng',
    70,
    'Color tokens',
    'juniper',
    'ms-juniper-1',
    'user-grace',
    'progress',
    2,
    12,
    2
  ),
  spec(
    'eng',
    71,
    'Type scale',
    'juniper',
    'ms-juniper-1',
    'user-ana',
    'progress',
    2,
    12,
    3
  ),
  spec(
    'ops',
    20,
    'Brand review sign-off',
    'juniper',
    'ms-juniper-1',
    'user-grace',
    'todo',
    3,
    10,
    4
  ),
  spec(
    'eng',
    72,
    'Button component',
    'juniper',
    'ms-juniper-2',
    'user-ben',
    'backlog',
    3,
    9,
    9
  ),
  spec(
    'eng',
    73,
    'Form components',
    'juniper',
    'ms-juniper-2',
    'user-grace',
    'backlog',
    3,
    9,
    9
  ),

  // Open issues without a project (My week's "No milestone" section).
  spec(
    'eng',
    80,
    'Update the on-call runbook',
    null,
    null,
    'user-ana',
    'todo',
    3,
    5,
    4
  ),
  spec(
    'ops',
    30,
    'Renew the monitoring contract',
    null,
    null,
    'user-ben',
    'progress',
    2,
    6,
    2
  ),
  spec(
    'ops',
    31,
    'Office network upgrade',
    null,
    null,
    null,
    'triage',
    0,
    2,
    2
  ),
];

const RELATION_SPECS: readonly {
  id: string;
  blocker: string;
  blocked: string;
}[] = [
  // Cross-project chain: OPS-20 (juniper) waits on ENG-23 (beacon), which
  // waits on ENG-12 — unassigned, in overdue ms-atlas-2.
  { id: 'rel-chain-1', blocker: 'iss-eng-12', blocked: 'iss-eng-23' },
  { id: 'rel-chain-2', blocker: 'iss-eng-23', blocked: 'iss-ops-20' },
  // A two-issue cycle inside ms-juniper-1.
  { id: 'rel-cycle-1', blocker: 'iss-eng-70', blocked: 'iss-eng-71' },
  { id: 'rel-cycle-2', blocker: 'iss-eng-71', blocked: 'iss-eng-70' },
  // A resolved blocker: ENG-2 is done.
  { id: 'rel-resolved', blocker: 'iss-eng-2', blocked: 'iss-eng-26' },
  // Same project, next milestone → later milestone.
  { id: 'rel-atlas', blocker: 'iss-eng-10', blocked: 'iss-eng-16' },
];

/**
 * The demo workspace with every date relative to `today`. Deterministic:
 * two calls with the same `today` return deep-equal data.
 */
export function createFixtureWorkspace(today: IsoDate): WorkspaceData {
  addDays(today, 0); // validates the format up front
  const relations: BlockingRelation[] = RELATION_SPECS.map((r) => ({
    id: r.id,
    blockerId: r.blocker,
    blockedId: r.blocked,
  }));
  return {
    workspaceId: FIXTURE_WORKSPACE.id,
    users: buildUsers(),
    teams: TEAMS.map((team) => ({
      ...team,
      memberIds: [...(team.memberIds ?? [])],
    })),
    states: buildStates(['eng', 'ops']),
    initiatives: buildInitiatives(today),
    projects: buildProjects(today),
    milestones: buildMilestones(today),
    issues: ISSUE_SPECS.map((s) => buildIssue(today, s, BASE_URL)),
    relations,
  };
}

// ---------------------------------------------------------------------------
// In-memory store and gateway
// ---------------------------------------------------------------------------

/** Mutable state behind one or more fixture gateways. */
export interface FixtureStore {
  data: WorkspaceData;
  /** Comments written through the gateway (allocation notes, people's). */
  comments: FixtureComment[];
  /** Clock for write timestamps; tests may replace it. */
  now: () => Date;
  /**
   * Additive (issue page): the demo discussion that existed before the
   * demo started; reads list it together with `comments`.
   */
  seededComments: FixtureComment[];
  /** Additive: per-issue fields the mirror does not keep, by issue id. */
  issueFields: Record<string, FixtureIssueFields>;
  /** Additive: every label, groups and archived ones included. */
  labels: FixtureLabel[];
  /** Additive: each team's estimate scale, by team id. */
  estimateScales: Record<string, EstimateScale>;
  /**
   * Additive: the number in the last `rel-<n>` id createBlockingRelation
   * handed out. It only grows, so an id is never reused after a delete
   * (Linear's ids are never reused either): a stale tab removing a
   * relation it saw earlier can only hit that relation, or none.
   */
  lastRelationNumber: number;
}

/**
 * Who a fixture gateway acts as (actor=app install, or a signed-in human).
 * createFixtureGateway also takes the plain form architecture §4 names:
 * a user id, or the string `'app'`.
 */
export type FixtureActor = { kind: 'app' } | { kind: 'user'; userId: string };

// The user id a fixture actor writes as: the app user for actor=app.
function fixtureActorUserId(actor: FixtureActor | string): string {
  if (typeof actor === 'string') {
    return actor === 'app' ? FIXTURE_APP_USER_ID : actor;
  }
  return actor.kind === 'app' ? FIXTURE_APP_USER_ID : actor.userId;
}

/** A fresh store over a fresh workspace; stores never share data. */
export function createFixtureStore(today: IsoDate): FixtureStore {
  const details = createFixtureIssueDetails(today);
  const data = createFixtureWorkspace(today);
  return {
    data,
    comments: [],
    now: () => new Date(),
    seededComments: details.seededComments,
    issueFields: details.issueFields,
    labels: details.labels,
    estimateScales: details.estimateScales,
    // The seeded relations have named ids; numbering starts after them, so
    // the first relation a person adds is `rel-<seeded count + 1>`.
    lastRelationNumber: data.relations.length,
  };
}

// Runs a synchronous body as a promise so thrown errors become rejections,
// matching how the real gateway fails.
function settle<T>(body: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(body());
  });
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function notFound(kind: string, id: string): LinearApiError {
  return new LinearApiError('not_found', `Fixture ${kind} not found: ${id}`);
}

const TIMELESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

function refused(message: string): LinearApiError {
  return new LinearApiError('invalid_input', message);
}

// A fixture label as the gateway contract shows it (groups resolved).
function toIssueLabel(
  entry: FixtureLabel,
  byId: ReadonlyMap<string, FixtureLabel>
): IssueLabel {
  const group = entry.parentId === null ? undefined : byId.get(entry.parentId);
  return {
    id: entry.id,
    name: entry.name,
    color: entry.color,
    teamId: entry.teamId,
    group:
      group === undefined
        ? null
        : {
            id: group.id,
            name: group.name,
            singleSelect: group.groupType !== 'multiSelect',
          },
  };
}

// Orders labels by name, then id, like the real gateway.
function byName(a: IssueLabel, b: IssueLabel): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A LinearGateway over `store`. Reads return deep copies; the four writes
 * mutate the store, so later reads (from any gateway on the same store)
 * see them. Unknown ids raise LinearApiError('not_found') on writes and
 * read as null on single-entity fetches, like the real gateway.
 */
export function createFixtureGateway(
  store: FixtureStore,
  actor: FixtureActor | string
): LinearGateway {
  const actorUserId = fixtureActorUserId(actor);

  function findIssue(id: string): Issue | undefined {
    return store.data.issues.find((issue) => issue.id === id);
  }

  function hasUser(id: string): boolean {
    return store.data.users.some((user) => user.id === id);
  }

  function labelsById(): Map<string, FixtureLabel> {
    return new Map(store.labels.map((entry) => [entry.id, entry]));
  }

  function fieldsOf(issueId: string): FixtureIssueFields {
    let entry = store.issueFields[issueId];
    if (entry === undefined) {
      entry = {
        description: null,
        labelIds: [],
        estimate: null,
        dueDate: null,
      };
      store.issueFields[issueId] = entry;
    }
    return entry;
  }

  // An issue as the gateway returns it: a copy carrying its due date from
  // the fields store (fixture-details.ts keeps it, its one source), as
  // Linear's IssueFields carry it. Reads never create a fields entry.
  function withFields(issue: Issue): Issue {
    return {
      ...copy(issue),
      dueDate: store.issueFields[issue.id]?.dueDate ?? null,
    };
  }

  function scaleOf(teamId: string): EstimateScale {
    return store.estimateScales[teamId] ?? NO_ESTIMATES;
  }

  function commentView(comment: FixtureComment): IssueComment {
    const author = store.data.users.find((u) => u.id === comment.authorId);
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      url: `${BASE_URL}/comment/${comment.id}`,
      parentId: comment.parentId ?? null,
      author:
        author === undefined ? null : { id: author.id, name: author.name },
      externalAuthor: author === undefined ? 'Unknown' : null,
    };
  }

  // Checks a label set the way Linear does: every label exists and is not
  // a group; a label newly applied is not archived and belongs to the
  // issue's team or the workspace (one the issue already carries may stay:
  // Linear keeps an archived label on its issues, linear.app/docs/labels);
  // a single-select group contributes at most one label.
  function checkLabels(issue: Issue, labelIds: readonly string[]): string[] {
    const byId = labelsById();
    const carried = new Set(fieldsOf(issue.id).labelIds);
    const unique = [...new Set(labelIds)];
    const groups = new Set<string>();
    for (const id of unique) {
      const entry = byId.get(id);
      const kept = carried.has(id);
      if (entry === undefined || (entry.archived && !kept)) {
        throw refused(`Label not found: ${id}`);
      }
      if (entry.isGroup) {
        throw refused(`${entry.name} is a label group and cannot be applied`);
      }
      if (!kept && entry.teamId !== null && entry.teamId !== issue.teamId) {
        throw refused(`${entry.name} is not a label of this issue's team`);
      }
      const group =
        entry.parentId === null ? undefined : byId.get(entry.parentId);
      if (group !== undefined && group.groupType !== 'multiSelect') {
        if (groups.has(group.id)) {
          throw refused(`Only one ${group.name} label can be applied`);
        }
        groups.add(group.id);
      }
    }
    return unique;
  }

  // Moves an issue to `next` and keeps its lifecycle timestamps plausible:
  // startedAt is set when it first starts, completedAt / canceledAt when
  // it closes (and cleared when it reopens).
  function moveToState(issue: Issue, next: WorkflowState, now: string): void {
    if (next.id === issue.stateId) return;
    issue.stateId = next.id;
    issue.lastStateChangeAt = now;
    if (next.type === 'started' && issue.startedAt === null) {
      issue.startedAt = now;
    }
    issue.completedAt = next.type === 'completed' ? now : null;
    issue.canceledAt = next.type === 'canceled' ? now : null;
  }

  // Applies a person's edit after checking it like Linear would; throws
  // LinearApiError('invalid_input') with Linear-like wording otherwise.
  function applyPatch(issue: Issue, patch: IssuePatch): void {
    const has = (key: keyof IssuePatch): boolean =>
      Object.hasOwn(patch, key) && patch[key] !== undefined;
    const keys = (Object.keys(patch) as (keyof IssuePatch)[]).filter(has);
    if (keys.length === 0) {
      throw refused('updateIssueFields needs at least one field');
    }
    const fields = fieldsOf(issue.id);
    let nextState: WorkflowState | undefined;
    if (has('title') && (patch.title ?? '').trim() === '') {
      throw refused('Title cannot be empty');
    }
    if (has('stateId')) {
      nextState = store.data.states.find((s) => s.id === patch.stateId);
      if (nextState === undefined || nextState.teamId !== issue.teamId) {
        throw refused(
          `State ${String(patch.stateId)} is not a state of ${issue.identifier}'s team`
        );
      }
    }
    if (has('assigneeId') && patch.assigneeId !== null) {
      if (!hasUser(String(patch.assigneeId))) {
        throw refused(`Unknown assignee: ${String(patch.assigneeId)}`);
      }
    }
    if (has('priority')) {
      const p = patch.priority;
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 4) {
        throw refused('Priority must be an integer from 0 to 4');
      }
    }
    let projectId = issue.projectId;
    if (has('projectId')) {
      projectId = patch.projectId ?? null;
      if (
        projectId !== null &&
        !store.data.projects.some((p) => p.id === projectId)
      ) {
        throw refused(`Project not found: ${projectId}`);
      }
    }
    let milestoneId = issue.milestoneId;
    if (has('projectMilestoneId')) {
      milestoneId = patch.projectMilestoneId ?? null;
    } else if (projectId !== issue.projectId) {
      // Moving to another project leaves the old project's milestone.
      milestoneId = null;
    }
    if (milestoneId !== null) {
      const milestone = store.data.milestones.find((m) => m.id === milestoneId);
      if (milestone === undefined || milestone.projectId !== projectId) {
        throw refused("The milestone must belong to the issue's project");
      }
    }
    if (has('dueDate') && patch.dueDate !== null) {
      if (!TIMELESS_DATE.test(String(patch.dueDate))) {
        throw refused('Due date must be YYYY-MM-DD');
      }
    }
    if (has('estimate') && patch.estimate !== null) {
      const estimate = Number(patch.estimate);
      if (!isAllowedEstimate(scaleOf(issue.teamId), estimate)) {
        throw refused(
          `Estimate ${estimate} is not on the team's estimate scale`
        );
      }
    }
    const labelIds = has('labelIds')
      ? checkLabels(issue, patch.labelIds ?? [])
      : null;

    const now = store.now().toISOString();
    if (has('title')) issue.title = String(patch.title).trim();
    if (has('description')) {
      const text = patch.description ?? null;
      fields.description = text === null || text.trim() === '' ? null : text;
    }
    if (nextState !== undefined) moveToState(issue, nextState, now);
    if (has('assigneeId')) issue.assigneeId = patch.assigneeId ?? null;
    if (has('priority')) issue.priority = patch.priority ?? 0;
    issue.projectId = projectId;
    issue.milestoneId = milestoneId;
    if (has('dueDate')) fields.dueDate = patch.dueDate ?? null;
    if (has('estimate')) fields.estimate = patch.estimate ?? null;
    if (labelIds !== null) fields.labelIds = labelIds;
    issue.updatedAt = now;
  }

  return {
    whoAmI(): Promise<LinearIdentity> {
      return settle(() => {
        const user = store.data.users.find((u) => u.id === actorUserId);
        if (user === undefined) {
          throw new LinearApiError(
            'unauthorized',
            `Fixture user not found: ${actorUserId}`
          );
        }
        return { user: copy(user), workspace: { ...FIXTURE_WORKSPACE } };
      });
    },

    fetchWorkspace(): Promise<WorkspaceData> {
      return settle(() => {
        const { issues, ...rest } = store.data;
        return { ...copy(rest), issues: issues.map(withFields) };
      });
    },

    fetchLastStateChanges(
      issueIds: string[]
    ): Promise<Map<string, IsoDateTime>> {
      return settle(() => {
        const wanted = new Set(issueIds);
        const out = new Map<string, IsoDateTime>();
        for (const issue of store.data.issues) {
          if (wanted.has(issue.id)) out.set(issue.id, issue.lastStateChangeAt);
        }
        return out;
      });
    },

    fetchIssue(id: string): Promise<Issue | null> {
      return settle(() => {
        const issue = findIssue(id);
        return issue === undefined ? null : withFields(issue);
      });
    },

    fetchIssueRelations(issueId: string): Promise<BlockingRelation[]> {
      return settle(() =>
        copy(
          store.data.relations.filter(
            (r) => r.blockerId === issueId || r.blockedId === issueId
          )
        )
      );
    },

    fetchProject(
      id: string
    ): Promise<{ project: Project; milestones: Milestone[] } | null> {
      return settle(() => {
        const project = store.data.projects.find((p) => p.id === id);
        if (project === undefined) return null;
        return {
          project: copy(project),
          milestones: copy(
            store.data.milestones.filter((m) => m.projectId === id)
          ),
        };
      });
    },

    fetchMilestone(id: string): Promise<Milestone | null> {
      return settle(() => {
        const milestone = store.data.milestones.find((m) => m.id === id);
        return milestone === undefined ? null : copy(milestone);
      });
    },

    fetchUser(id: string): Promise<User | null> {
      return settle(() => {
        const user = store.data.users.find((u) => u.id === id);
        return user === undefined ? null : copy(user);
      });
    },

    fetchInitiative(id: string): Promise<Initiative | null> {
      return settle(() => {
        const initiative = store.data.initiatives.find((i) => i.id === id);
        return initiative === undefined ? null : copy(initiative);
      });
    },

    updateIssue(
      id: string,
      input: { assigneeId?: string; stateId?: string }
    ): Promise<Issue> {
      return settle(() => {
        const issue = findIssue(id);
        if (issue === undefined) throw notFound('issue', id);
        if (input.assigneeId === undefined && input.stateId === undefined) {
          throw new LinearApiError(
            'invalid_input',
            'updateIssue needs assigneeId or stateId'
          );
        }
        if (input.assigneeId !== undefined && !hasUser(input.assigneeId)) {
          throw new LinearApiError(
            'invalid_input',
            `Unknown assignee: ${input.assigneeId}`
          );
        }
        const nextState =
          input.stateId === undefined
            ? undefined
            : store.data.states.find((s) => s.id === input.stateId);
        if (
          input.stateId !== undefined &&
          (nextState === undefined || nextState.teamId !== issue.teamId)
        ) {
          throw new LinearApiError(
            'invalid_input',
            `State ${input.stateId} is not a state of ${issue.identifier}'s team`
          );
        }
        const now = store.now().toISOString();
        if (input.assigneeId !== undefined) issue.assigneeId = input.assigneeId;
        if (nextState !== undefined && nextState.id !== issue.stateId) {
          issue.stateId = nextState.id;
          issue.lastStateChangeAt = now;
        }
        issue.updatedAt = now;
        return withFields(issue);
      });
    },

    createComment(issueId: string, body: string): Promise<{ id: string }> {
      return settle(() => {
        if (findIssue(issueId) === undefined) throw notFound('issue', issueId);
        const id = `comment-${store.comments.length + 1}`;
        store.comments.push({
          id,
          issueId,
          body,
          authorId: actorUserId,
          createdAt: store.now().toISOString(),
        });
        return { id };
      });
    },

    updateMilestoneTargetDate(
      id: string,
      targetDate: IsoDate | null
    ): Promise<Milestone> {
      return settle(() => {
        const milestone = store.data.milestones.find((m) => m.id === id);
        if (milestone === undefined) throw notFound('milestone', id);
        if (targetDate !== null && !TIMELESS_DATE.test(targetDate)) {
          throw new LinearApiError(
            'invalid_input',
            `targetDate must be YYYY-MM-DD: ${targetDate}`
          );
        }
        milestone.targetDate = targetDate;
        return copy(milestone);
      });
    },

    updateProjectLead(id: string, leadId: string | null): Promise<Project> {
      return settle(() => {
        const project = store.data.projects.find((p) => p.id === id);
        if (project === undefined) throw notFound('project', id);
        if (leadId !== null && !hasUser(leadId)) {
          throw new LinearApiError('invalid_input', `Unknown lead: ${leadId}`);
        }
        project.leadId = leadId;
        return copy(project);
      });
    },

    fetchIssueDetail(issueId: string): Promise<IssueExtras | null> {
      return settle(() => {
        const issue = findIssue(issueId);
        if (issue === undefined) return null;
        const fields = fieldsOf(issueId);
        const byId = labelsById();
        const labels = fields.labelIds
          .flatMap((id) => {
            const entry = byId.get(id);
            return entry === undefined ? [] : [toIssueLabel(entry, byId)];
          })
          .sort(byName);
        const comments = [...store.seededComments, ...store.comments]
          .filter((comment) => comment.issueId === issueId)
          .sort((a, b) => {
            const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
            if (byTime !== 0) return byTime;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .map(commentView);
        return {
          issueId,
          description: fields.description,
          labels,
          estimate: fields.estimate,
          dueDate: fields.dueDate,
          comments,
          commentsTruncated: false,
          estimateScale: { ...scaleOf(issue.teamId) },
        };
      });
    },

    listIssueLabels(teamId: string): Promise<IssueLabel[]> {
      return settle(() => {
        const byId = labelsById();
        return store.labels
          .filter(
            (entry) =>
              !entry.archived &&
              !entry.isGroup &&
              (entry.teamId === null || entry.teamId === teamId)
          )
          .map((entry) => toIssueLabel(entry, byId))
          .sort(byName);
      });
    },

    updateIssueFields(issueId: string, patch: IssuePatch): Promise<Issue> {
      return settle(() => {
        const issue = findIssue(issueId);
        if (issue === undefined) throw notFound('issue', issueId);
        applyPatch(issue, patch);
        return withFields(issue);
      });
    },

    createBlockingRelation(
      blockerIssueId: string,
      blockedIssueId: string
    ): Promise<BlockingRelation> {
      return settle(() => {
        if (findIssue(blockerIssueId) === undefined) {
          throw notFound('issue', blockerIssueId);
        }
        if (findIssue(blockedIssueId) === undefined) {
          throw notFound('issue', blockedIssueId);
        }
        if (blockerIssueId === blockedIssueId) {
          throw refused('An issue cannot block itself');
        }
        const relations = store.data.relations;
        if (
          relations.some(
            (r) =>
              r.blockerId === blockerIssueId && r.blockedId === blockedIssueId
          )
        ) {
          throw refused('These issues already have this relation');
        }
        // A monotonic counter, never the smallest free number: reusing a
        // deleted relation's id would let a stale tab's remove hit a
        // different relation. The loop only skips an id a test planted.
        let n = store.lastRelationNumber + 1;
        while (relations.some((r) => r.id === `rel-${n}`)) n += 1;
        store.lastRelationNumber = n;
        const relation: BlockingRelation = {
          id: `rel-${n}`,
          blockerId: blockerIssueId,
          blockedId: blockedIssueId,
        };
        relations.push(relation);
        const now = store.now().toISOString();
        for (const id of [blockerIssueId, blockedIssueId]) {
          const touched = findIssue(id);
          if (touched !== undefined) touched.updatedAt = now;
        }
        return copy(relation);
      });
    },

    deleteRelation(relationId: string): Promise<void> {
      return settle(() => {
        const index = store.data.relations.findIndex(
          (r) => r.id === relationId
        );
        if (index === -1) throw notFound('relation', relationId);
        store.data.relations.splice(index, 1);
      });
    },
  };
}
