// Demo content for the issue page (owner decision 2026-10-21): the fields
// the mirror does not keep, for the fictional "Northwind Labs" workspace in
// fixture.ts. Descriptions on most issues, a few labels per team (with a
// single-select group, an archived label and workspace labels), estimates
// on each team's scale (Engineering: Fibonacci; Operations: extended
// T-shirt sizes with zero allowed), some due dates and a short discussion
// on the issues that matter in the demo. Dates are relative to `today`,
// like the rest of the fixture, and nothing here names real people.

import type { EstimateScale, IsoDate, IsoDateTime } from '@dispatch/planning';

/** Per-issue fields the fixture keeps next to the mirrored issue. */
export interface FixtureIssueFields {
  description: string | null;
  labelIds: string[];
  estimate: number | null;
  dueDate: IsoDate | null;
}

/** A label in the fixture workspace, including groups and archived ones. */
export interface FixtureLabel {
  id: string;
  name: string;
  /** Linear's hex colour; the planner draws it only as the label
      picker's small swatch. */
  color: string;
  /** null = workspace label. */
  teamId: string | null;
  /** The group (a label with isGroup) this label belongs to. */
  parentId: string | null;
  isGroup: boolean;
  /** For groups: Linear's selection mode; null reads as single-select. */
  groupType: 'singleSelect' | 'multiSelect' | null;
  archived: boolean;
}

/** A comment in the fixture workspace. */
export interface FixtureComment {
  id: string;
  issueId: string;
  body: string;
  authorId: string;
  createdAt: IsoDateTime;
  /** The comment this one replies to (seeded threads only). */
  parentId?: string;
}

/** Everything the fixture adds for the issue page. */
export interface FixtureIssueDetails {
  issueFields: Record<string, FixtureIssueFields>;
  labels: FixtureLabel[];
  estimateScales: Record<string, EstimateScale>;
  seededComments: FixtureComment[];
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// `date` plus `days` calendar days, in UTC (same helper as fixture.ts).
function addDays(date: IsoDate, days: number): IsoDate {
  const match = ISO_DATE.exec(date);
  if (match === null) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Labels and estimate scales
// ---------------------------------------------------------------------------

function label(
  id: string,
  name: string,
  color: string,
  teamId: string | null,
  options: Partial<
    Pick<FixtureLabel, 'parentId' | 'isGroup' | 'groupType' | 'archived'>
  > = {}
): FixtureLabel {
  return {
    id,
    name,
    color,
    teamId,
    parentId: options.parentId ?? null,
    isGroup: options.isGroup ?? false,
    groupType: options.groupType ?? null,
    archived: options.archived ?? false,
  };
}

const LABELS: readonly FixtureLabel[] = [
  // Workspace labels: usable on every team's issues.
  label('lbl-bug', 'Bug', '#eb5757', null),
  label('lbl-feature', 'Feature', '#bb87fc', null),
  label('lbl-improvement', 'Improvement', '#4ea7fc', null),
  label('lbl-customer', 'Customer request', '#f2c94c', null),
  label('lbl-security', 'Security', '#f2994a', null),
  label('lbl-legacy', 'Legacy', '#95a2b3', null, { archived: true }),
  // Engineering: two team labels and a single-select "Area" group.
  label('lbl-eng-tech-debt', 'Tech debt', '#95a2b3', 'team-eng'),
  label('lbl-eng-performance', 'Performance', '#26b5ce', 'team-eng'),
  label('lbl-eng-area', 'Area', '#5e6ad2', 'team-eng', {
    isGroup: true,
    groupType: 'singleSelect',
  }),
  label('lbl-eng-frontend', 'Frontend', '#5e6ad2', 'team-eng', {
    parentId: 'lbl-eng-area',
  }),
  label('lbl-eng-backend', 'Backend', '#5e6ad2', 'team-eng', {
    parentId: 'lbl-eng-area',
  }),
  label('lbl-eng-mobile', 'Mobile', '#5e6ad2', 'team-eng', {
    parentId: 'lbl-eng-area',
  }),
  // Operations: team labels only.
  label('lbl-ops-infra', 'Infrastructure', '#0f783c', 'team-ops'),
  label('lbl-ops-vendor', 'Vendor', '#4cb782', 'team-ops'),
  label('lbl-ops-process', 'Process', '#26b5ce', 'team-ops'),
];

const ESTIMATE_SCALES: Record<string, EstimateScale> = {
  'team-eng': { type: 'fibonacci', allowZero: false, extended: false },
  'team-ops': { type: 'tShirt', allowZero: true, extended: true },
};

// ---------------------------------------------------------------------------
// Issue fields
// ---------------------------------------------------------------------------

interface FieldSpec {
  description: string | null;
  labels: string[];
  estimate: number | null;
  /** Days from today; null = no due date. */
  due: number | null;
}

function fields(
  description: string | null,
  labels: string[],
  estimate: number | null,
  due: number | null = null
): FieldSpec {
  return { description, labels, estimate, due };
}

// Keyed by fixture issue id. Issues not listed have no extra fields.
const FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  'iss-eng-1': fields(
    'Model invoices, payments and adjustments as append-only ledger entries.\n\n- One row per money movement\n- Balances are derived, never stored\n- Every entry carries the source system and a correlation id',
    ['lbl-feature', 'lbl-eng-backend'],
    5
  ),
  'iss-eng-2': fields(
    'Move the invoices table onto the new ledger schema. Keep the old table readable until the read path switches.',
    ['lbl-eng-tech-debt', 'lbl-eng-backend'],
    3
  ),
  'iss-eng-3': fields(
    'Canceled: history stays in the legacy ledger and is read through the compatibility view.',
    ['lbl-eng-backend'],
    8
  ),
  'iss-eng-10': fields(
    'Write every invoice to both ledgers behind the `ledger_dual_write` flag.\n\n**Acceptance**\n- Writes to both ledgers commit together or not at all\n- Latency stays within 10% of today',
    ['lbl-feature', 'lbl-eng-backend'],
    5,
    -1
  ),
  'iss-eng-11': fields(
    'Same as invoices, for payments. Refunds are payments with a negative amount.',
    ['lbl-feature', 'lbl-eng-backend'],
    5
  ),
  'iss-eng-12': fields(
    'Staging shows the two ledgers disagreeing on a small share of invoices. Find the cause and add a nightly reconciler that reports (and can repair) drift.\n\n1. Reproduce with the staging replay\n2. Write the reconciler\n3. Alert when drift is above zero for two nights',
    ['lbl-bug', 'lbl-eng-backend'],
    3,
    -2
  ),
  'iss-eng-13': fields(
    'A per-workspace flag so dual-write can be turned on gradually and off instantly.',
    ['lbl-improvement', 'lbl-eng-backend'],
    1
  ),
  'iss-eng-14': fields(
    'Duplicate of the audit logging that ENG-11 already covers.',
    [],
    null
  ),
  'iss-eng-16': fields(
    'Compare every read served by the new ledger with the legacy answer and log mismatches.',
    ['lbl-eng-backend'],
    3
  ),
  'iss-eng-17': fields(
    'Switch reads to the new ledger once parity checks have been green for a week.',
    ['lbl-feature', 'lbl-eng-backend'],
    8,
    25
  ),
  'iss-eng-18': fields(
    'Drop the legacy ledger tables and the compatibility view after the read path switch.',
    ['lbl-eng-tech-debt'],
    5
  ),
  'iss-eng-20': fields(
    'Index products, variants and categories. Full rebuild under 10 minutes.',
    ['lbl-feature', 'lbl-eng-backend'],
    5
  ),
  'iss-eng-21': fields(
    'Parse quoted phrases, minus terms and field filters (`brand:`).',
    ['lbl-feature', 'lbl-eng-backend'],
    3
  ),
  'iss-eng-22': fields(
    'Blend text relevance with popularity; keep the old ranking behind a flag for comparison.',
    ['lbl-feature', 'lbl-eng-backend', 'lbl-eng-performance'],
    8
  ),
  'iss-eng-23': fields(
    'Match queries with one or two typos ("headphnes" finds headphones). Beta customers asked for this first.',
    ['lbl-feature', 'lbl-customer', 'lbl-eng-backend'],
    5,
    2
  ),
  'iss-eng-24': fields(
    'Send query, result count and click position events so we can measure search quality.',
    ['lbl-improvement', 'lbl-eng-frontend'],
    2
  ),
  'iss-eng-25': fields(
    'A small "Was this helpful?" widget under the results, beta workspaces only.',
    ['lbl-feature', 'lbl-eng-frontend'],
    2
  ),
  'iss-eng-26': fields(
    'Spacing, empty state and keyboard navigation on the results page.',
    ['lbl-improvement', 'lbl-eng-frontend'],
    1
  ),
  'iss-eng-27': fields(
    'Let admins define synonyms ("tee" = "t-shirt").',
    ['lbl-feature', 'lbl-eng-frontend'],
    3
  ),
  'iss-eng-28': fields(null, [], 1),
  'iss-eng-30': fields(
    'The checklist new workspaces see on first sign-in: create a project, invite a teammate, connect an integration.',
    ['lbl-feature', 'lbl-eng-frontend'],
    3,
    4
  ),
  'iss-eng-31': fields(
    'Offer a sample project (with milestones) so the checklist has something to show.',
    ['lbl-feature', 'lbl-eng-backend'],
    5
  ),
  'iss-eng-32': fields(
    'Three starter templates: product launch, bug triage, hiring.',
    ['lbl-feature'],
    3
  ),
  'iss-eng-33': fields(
    'From two sales calls: prospects want SAML SSO configured during onboarding, not after.',
    ['lbl-customer', 'lbl-security'],
    null
  ),
  'iss-eng-34': fields(
    'Track each checklist step so we can see where new workspaces stop.',
    ['lbl-improvement', 'lbl-eng-frontend'],
    2
  ),
  'iss-eng-35': fields(
    'Invite by email or link from the setup flow; admins approve link joins.',
    ['lbl-feature', 'lbl-eng-frontend'],
    5
  ),
  'iss-eng-36': fields(
    'Extract the setup copy into message files and send them for translation.',
    ['lbl-eng-frontend'],
    2
  ),
  'iss-eng-40': fields(
    'One email per user per day listing what changed in their projects.',
    ['lbl-feature', 'lbl-eng-frontend'],
    2
  ),
  'iss-eng-41': fields(
    "Send digests at 8:00 in each user's timezone; skip days with nothing to say.",
    ['lbl-feature', 'lbl-eng-backend'],
    3
  ),
  'iss-eng-50': fields(
    'Queue writes made offline and replay them in order when the device reconnects.',
    ['lbl-feature', 'lbl-eng-mobile'],
    8
  ),
  'iss-eng-51': fields(
    'Last writer wins per field; a conflicting delete wins over an edit.',
    ['lbl-eng-mobile'],
    5
  ),
  'iss-eng-52': fields(
    'Show "Offline · 3 changes waiting" in the header while the queue is not empty.',
    ['lbl-improvement', 'lbl-eng-mobile'],
    2
  ),
  'iss-eng-53': fields(null, [], 1),
  'iss-eng-54': fields(
    'The app crashes on cold start when the offline queue is empty (Android 14).\n\n**Steps**\n1. Clear app data\n2. Sign in, force-quit\n3. Open the app again',
    ['lbl-bug', 'lbl-eng-mobile'],
    2,
    1
  ),
  'iss-eng-55': fields(null, ['lbl-improvement', 'lbl-eng-mobile'], 1),
  'iss-eng-60': fields(
    'OAuth 2 token exchange and refresh for the v3 API, with rotating refresh tokens.',
    ['lbl-feature', 'lbl-security', 'lbl-eng-backend'],
    5,
    3
  ),
  'iss-eng-61': fields(
    'Return remaining requests and the reset time on every v3 response.',
    ['lbl-feature', 'lbl-eng-backend'],
    2
  ),
  'iss-eng-62': fields(
    'Reference pages generated from the v3 schema, with one example per endpoint.',
    ['lbl-improvement'],
    3
  ),
  'iss-eng-63': fields(
    'Email owners of v2 keys, then stop issuing new v2 keys.',
    ['lbl-eng-backend'],
    3
  ),
  'iss-eng-70': fields(
    'Named colour tokens for surfaces, text and borders, light and dark.',
    ['lbl-eng-frontend'],
    3
  ),
  'iss-eng-71': fields(
    'A type ramp of six sizes with line heights that fit the 4px grid.',
    ['lbl-eng-frontend'],
    2
  ),
  'iss-eng-72': fields(
    'Primary, secondary and quiet buttons with loading and disabled states.',
    ['lbl-feature', 'lbl-eng-frontend'],
    3
  ),
  'iss-eng-73': fields(
    'Text field, select, checkbox and radio, all labelled and keyboard friendly.',
    ['lbl-feature', 'lbl-eng-frontend'],
    5
  ),
  'iss-eng-80': fields(
    'Bring the on-call runbook up to date with the new alerting setup.',
    [],
    1
  ),
  'iss-ops-1': fields(
    'Three emails over the first week: welcome, first project, invite your team.',
    ['lbl-ops-process'],
    3
  ),
  'iss-ops-2': fields(
    'Check every translated setup screen on a phone and a laptop.',
    [],
    2
  ),
  'iss-ops-5': fields(
    'A background job that writes the export to storage and emails a link.',
    ['lbl-ops-infra'],
    5
  ),
  'iss-ops-6': fields(
    'Only admins and report owners can export; every export is logged.',
    ['lbl-security'],
    3
  ),
  'iss-ops-8': fields(
    'Daily active users and actions per workspace for the last 90 days.',
    ['lbl-ops-infra'],
    8
  ),
  'iss-ops-9': fields(null, [], 3),
  'iss-ops-20': fields(
    'Brand team signs off on colours and type before the tokens ship.',
    ['lbl-ops-process'],
    1,
    10
  ),
  'iss-ops-30': fields(
    'The monitoring contract renews at the end of the month; get the quote approved and the PO signed.',
    ['lbl-ops-vendor'],
    2,
    9
  ),
  'iss-ops-31': fields(
    'The office Wi-Fi drops every afternoon. Needs a site survey and a quote.',
    ['lbl-ops-infra'],
    null
  ),
};

// ---------------------------------------------------------------------------
// Seeded discussion
// ---------------------------------------------------------------------------

interface CommentSpec {
  issueId: string;
  authorId: string;
  /** Days ago, plus the hour of day (UTC) so threads read in order. */
  daysAgo: number;
  hour: number;
  body: string;
  /** Index (in COMMENT_SPECS) of the comment this one replies to. */
  replyTo?: number;
}

const COMMENT_SPECS: readonly CommentSpec[] = [
  {
    issueId: 'iss-eng-12',
    authorId: 'user-chloe',
    daysAgo: 6,
    hour: 10,
    body: 'Drift shows up on about 0.3% of invoices in staging, always a payment that lands between the two writes. We need the reconciler before the cutover, not after.',
  },
  {
    issueId: 'iss-eng-12',
    authorId: 'user-ben',
    daysAgo: 5,
    hour: 14,
    body: 'Agreed. I can pair on it once payments dual-write is in review.',
    replyTo: 0,
  },
  {
    issueId: 'iss-eng-12',
    authorId: 'user-ana',
    daysAgo: 2,
    hour: 9,
    body: "This also holds up Beacon's typo tolerance (ENG-23 waits on it). Who can pick it up this week?",
  },
  {
    issueId: 'iss-eng-23',
    authorId: 'user-dev',
    daysAgo: 3,
    hour: 11,
    body: 'Typo tolerance works on our side; results disagree between the ledgers when amounts are rounded, so this waits on the drift fix in ENG-12.',
  },
  {
    issueId: 'iss-eng-31',
    authorId: 'user-ana',
    daysAgo: 3,
    hour: 16,
    body: 'The sample data should include one project with milestones so the checklist has something to show.',
  },
  {
    issueId: 'iss-eng-54',
    authorId: 'user-ben',
    daysAgo: 1,
    hour: 8,
    body: 'Repro: cold start on Android 14 with an empty offline queue. The crash report has the stack trace.',
  },
  {
    issueId: 'iss-eng-60',
    authorId: 'user-elena',
    daysAgo: 4,
    hour: 13,
    body: 'Token exchange works end to end; refresh rotation still needs tests.',
  },
  {
    issueId: 'iss-eng-61',
    authorId: 'user-ben',
    daysAgo: 1,
    hour: 15,
    body: 'Should the header names follow the common `x-ratelimit-*` style? Leaning yes, people know it.',
  },
  {
    issueId: 'iss-eng-70',
    authorId: 'user-grace',
    daysAgo: 8,
    hour: 10,
    body: 'Colour tokens and the type scale wait on each other: tokens need the ramp for line heights, the ramp needs tokens for contrast. Proposal: freeze the ramp first.',
  },
  {
    issueId: 'iss-eng-71',
    authorId: 'user-ana',
    daysAgo: 7,
    hour: 12,
    body: 'Happy to freeze the ramp this week if the tokens can follow next week.',
  },
  {
    issueId: 'iss-ops-30',
    authorId: 'user-ben',
    daysAgo: 4,
    hour: 9,
    body: 'The vendor wants the signed PO a week before renewal.',
  },
  {
    issueId: 'iss-ops-31',
    authorId: 'user-femi',
    daysAgo: 2,
    hour: 17,
    body: 'Asked two vendors for a site survey; first quote expected Friday.',
  },
];

/**
 * The issue-page content of the demo workspace for `today`. Deterministic:
 * the same `today` gives deep-equal data.
 */
export function createFixtureIssueDetails(today: IsoDate): FixtureIssueDetails {
  const issueFields: Record<string, FixtureIssueFields> = {};
  for (const [issueId, spec] of Object.entries(FIELD_SPECS)) {
    issueFields[issueId] = {
      description: spec.description,
      labelIds: [...spec.labels],
      estimate: spec.estimate,
      dueDate: spec.due === null ? null : addDays(today, spec.due),
    };
  }
  const seededComments: FixtureComment[] = COMMENT_SPECS.map((spec, index) => {
    const hour = String(spec.hour).padStart(2, '0');
    const comment: FixtureComment = {
      id: `seed-comment-${index + 1}`,
      issueId: spec.issueId,
      body: spec.body,
      authorId: spec.authorId,
      createdAt: `${addDays(today, -spec.daysAgo)}T${hour}:00:00.000Z`,
    };
    if (spec.replyTo !== undefined) {
      comment.parentId = `seed-comment-${spec.replyTo + 1}`;
    }
    return comment;
  });
  return {
    issueFields,
    labels: LABELS.map((entry) => ({ ...entry })),
    estimateScales: Object.fromEntries(
      Object.entries(ESTIMATE_SCALES).map(([teamId, scale]) => [
        teamId,
        { ...scale },
      ])
    ),
    seededComments,
  };
}
