import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACTORS } from './paths.js';

export interface DemoTask {
  id: string;
  title: string;
  status: string;
  kind: 'epic' | 'task';
  parent: string | null;
  /** Bare actor handle (see ACTORS in paths.ts), not a wire-format ActorRef. */
  assignee: string;
  priority: string;
  labels: string[];
  blockedBy: string[];
  description: string;
  criteria: string[];
  /** How many days before BASE this task was created; `updated` is one day closer. */
  daysAgo: number;
}

// A one-off credit on a task's `## Activity` section, so attribution reads
// as plural work rather than one actor touching everything.
interface Activity {
  taskId: string;
  actor: string;
  line: string;
}

// Every timestamp is derived from this fixed instant, never Date.now(), so
// regenerating the board is byte-identical run to run.
const BASE_MS = Date.parse('2026-07-28T14:00:00.000Z');

function ago(days: number): string {
  return new Date(BASE_MS - days * 86400000).toISOString();
}

// The two epics and ten tasks that make up the storefront backlog, carried
// over from the marketing-screenshot fixture (.agents/ignore/gen-demo.py)
// with an assignee added to each so the board shows plural attribution.
export const TASKS: DemoTask[] = [
  {
    id: 'e-4a19c2',
    title: 'Checkout rewrite',
    status: 'in-progress',
    kind: 'epic',
    parent: null,
    assignee: 'wsoule679',
    priority: 'high',
    labels: [],
    blockedBy: [],
    description:
      'Replace the two-step checkout with a single page, and move cart state off the client.',
    criteria: [],
    daysAgo: 9,
  },
  {
    id: 'e-77b3e1',
    title: 'Search relevance',
    status: 'in-progress',
    kind: 'epic',
    parent: null,
    assignee: 'pmirand',
    priority: 'medium',
    labels: [],
    blockedBy: [],
    description:
      'Exact SKU matches should beat fuzzy ones, and the index should not take 40 minutes to rebuild.',
    criteria: [],
    daysAgo: 7,
  },
  {
    id: 't-9b2d14',
    title: 'Add address autocomplete',
    status: 'backlog',
    kind: 'task',
    parent: 'e-4a19c2',
    assignee: 'dokafor',
    priority: 'low',
    labels: [],
    blockedBy: [],
    description:
      'Wire the address field to the places API so people stop mistyping postcodes.',
    criteria: [],
    daysAgo: 6,
  },
  {
    id: 't-6c40de',
    title: 'Persist the cart across devices',
    status: 'todo',
    kind: 'task',
    parent: 'e-4a19c2',
    assignee: 'wsoule679',
    priority: 'high',
    labels: [],
    blockedBy: ['t-2e91aa'],
    description:
      'Once cart state lives in the session store, the same cart should follow a signed-in user between devices.',
    criteria: [
      'Cart survives sign-out and sign-in',
      'No cart data in localStorage',
    ],
    daysAgo: 5,
  },
  {
    id: 't-3f8a21',
    title: 'Validate discount codes server-side',
    status: 'todo',
    kind: 'task',
    parent: 'e-4a19c2',
    assignee: 'pmirand',
    priority: 'urgent',
    labels: ['security'],
    blockedBy: [],
    description:
      'The client currently decides whether a code is valid. Move the check behind the API.',
    criteria: ['Codes are verified server-side', 'Expired codes return 422'],
    daysAgo: 4,
  },
  {
    id: 't-2e91aa',
    title: 'Move cart state to the session store',
    status: 'in-review',
    kind: 'task',
    parent: 'e-4a19c2',
    assignee: 'dokafor',
    priority: 'high',
    labels: [],
    blockedBy: [],
    description: 'Cart lives in React state today, so a refresh loses it.',
    criteria: [],
    daysAgo: 3,
  },
  {
    id: 't-58cc03',
    title: 'Rank exact SKU matches above fuzzy',
    status: 'in-review',
    kind: 'task',
    parent: 'e-77b3e1',
    assignee: 'wsoule679',
    priority: 'high',
    labels: [],
    blockedBy: [],
    description:
      'Searching a full SKU returns fuzzy matches first, which is never what anyone wants.',
    criteria: [],
    daysAgo: 2,
  },
  {
    id: 't-1d77e5',
    title: 'Cache the search index in redis',
    status: 'todo',
    kind: 'task',
    parent: 'e-77b3e1',
    assignee: 'pmirand',
    priority: 'medium',
    labels: [],
    blockedBy: [],
    description: 'Rebuilds are slow and cold starts hit the database hard.',
    criteria: [],
    daysAgo: 3,
  },
  {
    id: 't-8ac410',
    title: 'Rate limit the search endpoint',
    status: 'todo',
    kind: 'task',
    parent: 'e-77b3e1',
    assignee: 'dokafor',
    priority: 'medium',
    labels: ['security'],
    blockedBy: [],
    description: 'One client can currently issue unbounded queries.',
    criteria: [],
    daysAgo: 3,
  },
  {
    id: 't-71ff03',
    title: 'Add a /health endpoint',
    status: 'done',
    kind: 'task',
    parent: 'e-4a19c2',
    assignee: 'wsoule679',
    priority: 'low',
    labels: [],
    blockedBy: [],
    description: 'The load balancer needs something cheap to poll.',
    criteria: [],
    daysAgo: 8,
  },
  {
    id: 't-0c9b88',
    title: 'Fix hyphenated SKU search',
    status: 'done',
    kind: 'task',
    parent: 'e-77b3e1',
    assignee: 'pmirand',
    priority: 'high',
    labels: [],
    blockedBy: [],
    description:
      'Hyphens were being stripped before tokenisation, so "AB-1200" matched nothing.',
    criteria: [],
    daysAgo: 6,
  },
  {
    id: 't-4e01af',
    title: 'Log slow queries over 200ms',
    status: 'done',
    kind: 'task',
    parent: 'e-77b3e1',
    assignee: 'dokafor',
    priority: 'low',
    labels: [],
    blockedBy: [],
    description: 'No visibility into which queries are the slow ones.',
    criteria: [],
    daysAgo: 7,
  },
];

// Three credits, one per actor, on the two in-review tasks (the ones
// BRANCH_FIXES gives a real diff to) plus a shipped one — enough for the
// activity feed to show three different people at work.
const ACTIVITY: Activity[] = [
  {
    taskId: 't-2e91aa',
    actor: 'dokafor',
    line: 'Moved cart state behind the session store; dispatched for review.',
  },
  {
    taskId: 't-58cc03',
    actor: 'wsoule679',
    line: 'Added an exact-match boost ahead of the fuzzy pass; dispatched for review.',
  },
  {
    taskId: 't-71ff03',
    actor: 'pmirand',
    line: 'Reviewed and merged — the load balancer can poll this now.',
  },
];

// Builds the `id: value` frontmatter lines in the exact order the merge
// driver expects, so a field-by-field 3-way merge lines up cleanly.
function frontmatter(task: DemoTask): string {
  const created = ago(task.daysAgo + 1);
  const updated = ago(task.daysAgo);
  return [
    '---',
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `kind: ${task.kind}`,
    `parent: ${task.parent ?? 'null'}`,
    'milestone: null',
    `blocked-by: [${task.blockedBy.join(', ')}]`,
    `labels: [${task.labels.join(', ')}]`,
    `priority: ${task.priority}`,
    `assignee: human:${task.assignee}`,
    `created: ${created}`,
    `updated: ${updated}`,
    'external: null',
    '---',
    '',
    '',
  ].join('\n');
}

function body(task: DemoTask): string {
  const lines = ['## Description', '', task.description, ''];
  if (task.criteria.length > 0) {
    lines.push(
      '## Acceptance Criteria',
      '',
      ...task.criteria.map((c) => `- ${c}`),
      ''
    );
  }
  const activity = ACTIVITY.filter((a) => a.taskId === task.id);
  if (activity.length > 0) {
    lines.push(
      '## Activity',
      '',
      ...activity.map((a) => `- ${a.line} — human:${a.actor}`),
      ''
    );
  }
  return lines.join('\n');
}

// Same slugging rule as the marketing-screenshot fixture: lowercase title,
// non-alphanumerics collapsed to `-`, capped at 40 chars.
function slug(title: string): string {
  return title
    .toLowerCase()
    .split('')
    .map((c) => (/[a-z0-9]/.test(c) ? c : '-'))
    .join('')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

function writeTasks(root: string): void {
  const dir = join(root, '.dispatch', 'tasks');
  mkdirSync(dir, { recursive: true });
  for (const task of TASKS) {
    const file = join(dir, `${task.id}-${slug(task.title)}.md`);
    writeFileSync(file, frontmatter(task) + body(task));
  }
}

function writeTeam(root: string): void {
  const lines = ['members:'];
  for (const actor of ACTORS) {
    lines.push(
      `  - handle: ${actor.handle}`,
      `    email: ${actor.email}`,
      `    displayName: ${actor.displayName}`,
      '    emails: []'
    );
  }
  writeFileSync(join(root, '.dispatch', 'team.yml'), `${lines.join('\n')}\n`);
}

// Every field the Settings tour can show is set away from its shipped
// default (see packages/core/src/config.ts and configTypes.ts), so opening
// Settings against the demo project always has something non-trivial to
// display. Holds no secret — the Linear API key lives outside the repo, in
// ~/.dispatch/credentials.json.
function writeConfig(root: string): void {
  const config = `statuses: [backlog, todo, in-progress, in-review, done, cancelled]
autoCommit: true

verifySteps:
  - name: typecheck
    command: bun run tsc
  - name: test
    command: bun test
  - name: lint
    command: bun run lint

orchestrator:
  epicConcurrency: 4
  maxTurns: 40
  verifyTimeoutSec: 900
  maxBudgetUsd: 5
  permissionMode: acceptEdits

models:
  execute: claude-sonnet-5
  plan: claude-opus-5
  draft: claude-sonnet-5
  enrich: claude-sonnet-5
  cluster: claude-sonnet-5
  summarize: claude-sonnet-5

fixLoop:
  cap: 4
  escalation:
    - round: 1
      strategy: resume
      modelTier: standard
    - round: 3
      strategy: fresh
      modelTier: high

carto:
  enabled: detect

verify:
  command: bun run src/server/routes.ts
  url: http://localhost:4000/health
  notes: Confirm /health returns 200, then check that an exact SKU search beats a fuzzy one and a discount code is checked server-side.

linear:
  enabled: true
  teamId: STORE
  statusMap:
    backlog: Backlog
    todo: To Do
    in-progress: In Progress
    in-review: In Review
    done: Shipped
    cancelled: Canceled
  intervalSec: 120
  direction: pull
`;
  writeFileSync(join(root, '.dispatch', 'config.yml'), config);
}

function writeGitattributes(root: string): void {
  writeFileSync(
    join(root, '.gitattributes'),
    '.dispatch/tasks/*.md merge=dispatch-task\n.dispatch/team.yml merge=dispatch-team\n'
  );
}

/** Lays down the committed `.dispatch/` board state: tasks, roster, config, merge-driver registration. */
export function writeBoard(root: string): void {
  writeTasks(root);
  writeTeam(root);
  writeConfig(root);
  writeGitattributes(root);
}
