import type {
  LabelDefinition,
  Person,
  StatusModel,
  TaskComment,
  TaskDoc,
  TaskListItem,
  TaskRisk,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import {
  canonicalKind,
  findDependencyCycles,
  isContainerKind,
  isDoneStatus,
  isValidParentKind,
  labelRef,
  parseLinearExternal,
  statusType,
  UNASSIGNED,
} from '@dispatch-foo/core/browser';
import type { LinearIssueLink, RunMeta } from '@dispatch/client';
import type {
  EstimateChoice,
  LabelChoice,
  PlanChoice,
  ShellCrumb,
  StateChoice,
  TaskActivityItem,
  TaskDetailAlert,
  TaskDetailStatus,
  TaskPriority,
  TaskSearchResult,
  UiTone,
} from '@dispatch/ui';
// The ui package's comment shape shares its name with core's record.
import type { TaskComment as UiTaskComment } from '@dispatch/ui';

import { parseActivity } from '../lib/activityFeed';
import {
  canModifyComment,
  commentThreads,
  isPendingComment,
} from '../lib/commentThreads';
import type {
  DispatchReadiness,
  ReadinessCheck,
} from '../lib/dispatchReadiness';
import { matchesIssueSearch, searchWords } from '../lib/issueSearch';
import { resolveLinearLink } from '../lib/linearSettings';
import { criteriaItems } from '../lib/reviewCriteria';
import { isTerminalRunState } from '../lib/runState';
import { dueDateInfo, formatShortDate } from '../lib/taskDates';
import {
  assigneeRef,
  kindLabel,
  parseTaskSections,
  priorityLabel,
  statusLabel,
} from '../lib/taskDisplay';
import { ancestorsOf } from '../lib/taskHierarchy';
import { blocksIn, type TaskIndex } from '../lib/taskIndex';
import { taskTimeline, type TimelineKind } from '../lib/taskTimeline';
import {
  type AssigneeChoice,
  assigneeDisplay,
  buildPersonChoices,
} from './people';
import { fromTaskPriority, NEEDS_ASSIGNEE_LABEL, toTaskPriority } from './rows';

// A Dispatch task (its TaskDoc, runs, comments, readiness, the project's
// people, label registry and status model) → the plain data @dispatch/ui's
// TaskDetail family takes: the header (key, crumbs, status), the alert stack,
// the property sheet's facts with the current value each edit control starts
// from, the picker choices, the UpdatePatch each save writes, the relations
// with their add and remove patches, the description sections, the comment
// thread and the activity ledger. Pure functions over plain data,
// deterministic for a given `now` / `today`, unit-tested without React: the
// view (Phase 3a's TaskSlideOver, Phase 3b's full page) only attaches the
// controls and callbacks. Everything the old TaskRail and TaskPage header
// showed has a place here; the wording follows the planner's issue adapter
// (Better-Tracker's lib/adapters/issue.ts) where the two meet.

/** What the view hands every builder: the window's data, as maps keyed by
 * task id so each builder is O(1) per lookup, plus who is looking. */
export interface DetailContext {
  /** The project's status model (`useStatusModelOf(config)`). */
  model: StatusModel;
  /** Every task the window knows (containers and archived tasks included). */
  tasksById: ReadonlyMap<string, TaskListItem>;
  /** `taskIndexOf(tasks)`: children, blockers and the label vocabulary. */
  index: TaskIndex;
  /** The person an assignee names (PeopleContext's `personFor`). */
  personFor: (assignee: string) => { name: string } | undefined;
  /** This window's own `human:<handle>` ref, or null until the daemon says. */
  me: string | null;
  /** `GET /api/linear/links`: issue UUID → identifier and URL. */
  linearLinks?: Readonly<Record<string, LinearIssueLink>>;
  /** The project's people registry (the assignee choices). */
  people: readonly Person[];
  /** The daemon's executors, by name (the "Agents" choices). */
  executors: readonly string[];
  /** The project's label registry (config `labels:`, synced from Linear). */
  labelCatalogue: readonly LabelDefinition[];
  /** The clock every date is read against. */
  now: Date;
  /** The local calendar day of `now`, `YYYY-MM-DD` (`dayFromNow(0, now)`). */
  today: string;
  /** Where a task opens (`taskHref`). */
  hrefFor: (taskId: string) => string;
  /** Whether this window may write: false hides every edit control. */
  canEdit: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A `YYYY-MM-DD` day as local midnight, so a date never shows the day before
// in the west (`new Date('2026-10-26')` is UTC midnight).
function calendarDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// "just now", "5m ago", "3h ago", "2d ago" under a week, then the calendar
// day ("Sep 13"), read against `now` rather than the wall clock so the output
// is stable in tests and across a long-open window.
function relativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diff = now.getTime() - then;
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < WEEK_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return formatShortDate(iso, now);
}

function linearLinkOf(
  external: string | null,
  ctx: DetailContext
): LinearIssueLink | null {
  return ctx.linearLinks === undefined
    ? null
    : resolveLinearLink(external, ctx.linearLinks);
}

/** The key a task is shown by: its Linear identifier when linked and the
 * links map knows it, else its id. */
function taskKeyOf(doc: TaskListItem, ctx: DetailContext): string {
  return linearLinkOf(doc.meta.external, ctx)?.identifier ?? doc.meta.id;
}

function stateOf(status: string, model: StatusModel): TaskDetailStatus {
  return { kind: statusType(status, model), label: statusLabel(status) };
}

/* ---- header ------------------------------------------------------------- */

export interface DetailHeader {
  /** The Linear identifier when linked, else the task id. */
  taskKey: string;
  title: string;
  /** The issue in Linear, when linked. */
  href?: string;
  /** The containers above the task (initiative › project › milestone ›
   * parent issue), each linking to its own page, then the key. */
  breadcrumb: ShellCrumb[];
  status: TaskDetailStatus;
  /** Completed or canceled. */
  closed: boolean;
}

/** The header bar's facts: key, title ("Untitled task" when blank), the
 * Linear link, the crumb trail and the status glyph's kind and label. */
export function buildDetailHeader(
  doc: TaskListItem,
  ctx: DetailContext
): DetailHeader {
  const { meta } = doc;
  const link = linearLinkOf(meta.external, ctx);
  const taskKey = link?.identifier ?? meta.id;
  const breadcrumb: ShellCrumb[] = ancestorsOf(doc, ctx.tasksById).map(
    (ancestor) => ({
      label: ancestor.meta.title,
      href: ctx.hrefFor(ancestor.meta.id),
    })
  );
  breadcrumb.push({ label: taskKey });
  const out: DetailHeader = {
    taskKey,
    title: meta.title === '' ? 'Untitled task' : meta.title,
    breadcrumb,
    status: stateOf(meta.status, ctx.model),
    closed: isDoneStatus(meta.status, ctx.model),
  };
  if (link !== null) out.href = link.url;
  return out;
}

/* ---- alerts ------------------------------------------------------------- */

export interface DetailAlertsInput {
  doc: TaskListItem;
  model: StatusModel;
  /** `dispatchReadiness` for the task, or null while it is not known. */
  readiness: DispatchReadiness | null;
  /** The task's newest execute run. */
  latestRun: RunMeta | undefined;
  /** Open asks waiting on this person about the task (`needsYou().byTask`). */
  asksCount: number;
  now: Date;
}

// Most severe first: red before amber before grey.
const TONE_RANK: Record<UiTone, number> = {
  danger: 0,
  warning: 1,
  info: 2,
  success: 2,
  accent: 2,
  default: 3,
  muted: 4,
};

// The readiness checks the alert stack repeats, with their lead-in words;
// `writes` ("No declared writes") is advice for the dispatch card, not an
// alert, and a passing or pending check says nothing here.
const CHECK_LABEL: Partial<
  Record<ReadinessCheck['id'], Partial<Record<ReadinessCheck['tone'], string>>>
> = {
  blockers: { block: 'Blocked', warn: 'Blockers' },
  spec: { warn: 'Thin spec' },
  overlap: { warn: 'Overlaps' },
};

function readinessAlert(check: ReadinessCheck): TaskDetailAlert | null {
  const label = CHECK_LABEL[check.id]?.[check.tone];
  if (label === undefined) return null;
  // Blocked (amber) and a missing input (amber) share the hue, as §8.2 says.
  return {
    id: `readiness-${check.id}`,
    label,
    tone: 'warning',
    message: `${check.label}.`,
  };
}

/** A failed or interrupted run nobody has closed out yet (discarding a failed
 * run is a normal way to close one, and then it is no longer news). */
function failedUnreviewed(run: RunMeta): boolean {
  return (
    (run.state === 'failed' || run.state === 'interrupted-dirty') &&
    run.reviewedAt === undefined
  );
}

function runFailureMessage(run: RunMeta): string {
  if (run.state === 'interrupted-dirty') {
    return 'The latest run was interrupted and left uncommitted work.';
  }
  const error = (run.error ?? '').trim().replace(/\.$/, '');
  return error === ''
    ? 'The latest run failed.'
    : `The latest run failed: ${error}.`;
}

/**
 * The alert strips above the properties, most severe first: the due date is
 * past (danger), questions wait on you (warning), the latest run failed
 * (danger), readiness holds it back or wants a look (unmet blockers, a thin
 * spec, overlapping live runs: warning), and the task is archived (muted). A
 * closed task is never overdue and gets no readiness advice, nor does a
 * container (it is not dispatched).
 */
export function buildDetailAlerts(input: DetailAlertsInput): TaskDetailAlert[] {
  const { doc, model, readiness, latestRun, asksCount, now } = input;
  const { meta } = doc;
  const closed = isDoneStatus(meta.status, model);
  const alerts: TaskDetailAlert[] = [];
  if (meta.dueDate !== null && !closed) {
    const due = dueDateInfo(meta.dueDate, now);
    if (due.overdue) {
      alerts.push({
        id: 'overdue',
        label: 'Overdue',
        tone: 'danger',
        message: `Due ${due.date}, ${due.relative}.`,
      });
    }
  }
  if (asksCount > 0) {
    alerts.push({
      id: 'asks',
      label: 'Needs you',
      tone: 'warning',
      message: `${plural(asksCount, 'question')} waiting on you.`,
    });
  }
  if (latestRun !== undefined && failedUnreviewed(latestRun)) {
    alerts.push({
      id: 'run-failed',
      label: 'Failed',
      tone: 'danger',
      message: runFailureMessage(latestRun),
    });
  }
  if (readiness !== null && !closed && !isContainerKind(meta.kind)) {
    for (const check of readiness.checks) {
      const alert = readinessAlert(check);
      if (alert !== null) alerts.push(alert);
    }
  }
  if (meta.archivedAt !== undefined) {
    alerts.push({
      id: 'archived',
      label: 'Archived',
      tone: 'muted',
      message: `Archived ${formatShortDate(meta.archivedAt, now)}.`,
    });
  }
  // Array.prototype.sort is stable, so alerts of one tone keep the order above.
  return alerts.sort(
    (a, b) => TONE_RANK[a.tone ?? 'warning'] - TONE_RANK[b.tone ?? 'warning']
  );
}

/* ---- facts (the property sheet) ----------------------------------------- */

export type FactId =
  | 'status'
  | 'assignee'
  | 'priority'
  | 'labels'
  | 'estimate'
  | 'start'
  | 'due'
  | 'parent'
  | 'cycle'
  | 'creator'
  | 'risk'
  | 'model'
  | 'selfReview'
  | 'exercised'
  | 'external';

interface FactBase {
  id: FactId;
  /** The property's name ("Assignee"). */
  label: string;
  /** The value as read-only text ("Wyatt Soule", "No estimate"). */
  value: string;
  /** The value's colour (§8.2): warning "Needs assignee", danger an overdue
   * date, muted an unset value. */
  tone?: UiTone;
  /** A word or two beside the value ("Overdue", "Milestone", "Created Sep 25"). */
  note?: string;
  /** Whether the view puts a control here: the window may write, and the
   * property has an editor (@dispatch/ui has none for a cycle, and the
   * creator, risk, model, verification and tracker link are facts). */
  editable: boolean;
}

/** One row of the property sheet, with the typed current value the row's
 * control starts from (`raw`); `kind` says which control that is. */
export type DetailFact = FactBase &
  (
    | { kind: 'state'; raw: string }
    | { kind: 'person'; raw: string | null }
    | { kind: 'priority'; raw: TaskPriority }
    | { kind: 'labels'; raw: string[] }
    | { kind: 'estimate'; raw: number | null }
    | { kind: 'date'; raw: string | null }
    | { kind: 'plan'; raw: string | null }
    | { kind: 'text'; raw: string | null }
    | { kind: 'switch'; raw: boolean }
    | { kind: 'link'; raw: string | null; href?: string }
  );

/** `3 points`, `1 point`. */
function estimateLabel(estimate: number): string {
  return `${estimate} point${estimate === 1 ? '' : 's'}`;
}

const RISK_TONE: Partial<Record<TaskRisk, UiTone>> = {
  elevated: 'warning',
  critical: 'danger',
};

/**
 * The property sheet, in the rail's order: status, assignee, priority,
 * labels, estimate, start date (a container's, or when set), due date (toned
 * against `now`), parent, then the facts only shown when they say something
 * (cycle, creator, a non-routine risk, a model override), self review, and
 * whether a verify run exercised the work and where it lives in Linear.
 * `editable` is false everywhere when the window may not write.
 */
export function buildDetailFacts(
  doc: TaskListItem,
  ctx: DetailContext
): DetailFact[] {
  const { meta } = doc;
  const edit = ctx.canEdit;
  const container = isContainerKind(meta.kind);
  const closed = isDoneStatus(meta.status, ctx.model);
  const facts: DetailFact[] = [];

  facts.push({
    id: 'status',
    kind: 'state',
    label: 'Status',
    value: statusLabel(meta.status),
    editable: edit,
    raw: meta.status,
  });

  // Nobody on an open, specified task reads "Needs assignee" in amber (a
  // draft is not yet anyone's to pick up; a container or finished task needs
  // nobody), as the list rows do.
  const who = assigneeDisplay(meta.assignee, ctx.personFor);
  const unassigned = assigneeRef(meta.assignee) === null;
  const type = statusType(meta.status, ctx.model);
  const needsOne =
    unassigned &&
    !container &&
    !closed &&
    type !== 'backlog' &&
    type !== 'triage';
  const assignee: DetailFact = {
    id: 'assignee',
    kind: 'person',
    label: 'Assignee',
    value: needsOne ? NEEDS_ASSIGNEE_LABEL : who.label,
    editable: edit,
    raw: unassigned ? null : meta.assignee,
  };
  if (needsOne) assignee.tone = 'warning';
  else if (who.tone !== undefined) assignee.tone = who.tone;
  facts.push(assignee);

  const priority: DetailFact = {
    id: 'priority',
    kind: 'priority',
    label: 'Priority',
    value: priorityLabel(meta.priority),
    editable: edit,
    raw: toTaskPriority(meta.priority),
  };
  if (meta.priority === 'urgent') priority.tone = 'danger';
  facts.push(priority);

  const labels: DetailFact = {
    id: 'labels',
    kind: 'labels',
    label: 'Labels',
    value: meta.labels.length === 0 ? 'No labels' : meta.labels.join(', '),
    editable: edit,
    raw: [...meta.labels],
  };
  if (meta.labels.length === 0) labels.tone = 'muted';
  facts.push(labels);

  const estimate: DetailFact = {
    id: 'estimate',
    kind: 'estimate',
    label: 'Estimate',
    value:
      meta.estimate === null ? 'No estimate' : estimateLabel(meta.estimate),
    editable: edit,
    raw: meta.estimate,
  };
  if (meta.estimate === null) estimate.tone = 'muted';
  facts.push(estimate);

  if (container || meta.startDate !== null) {
    const start: DetailFact = {
      id: 'start',
      kind: 'date',
      label: 'Start date',
      value:
        meta.startDate === null
          ? 'No start date'
          : formatShortDate(calendarDay(meta.startDate), ctx.now),
      editable: edit,
      raw: meta.startDate,
    };
    if (meta.startDate === null) start.tone = 'muted';
    else start.note = meta.startDate <= ctx.today ? 'Started' : 'Starts';
    facts.push(start);
  }

  const due: DetailFact = {
    id: 'due',
    kind: 'date',
    label: 'Due date',
    value: 'No due date',
    editable: edit,
    raw: meta.dueDate,
  };
  if (meta.dueDate === null) due.tone = 'muted';
  else {
    // Red once past, amber on the day and the eve, plain otherwise; a finished
    // task's date is no longer a deadline, so it carries neither.
    const info = dueDateInfo(meta.dueDate, ctx.now, closed);
    due.value = info.date;
    if (!closed) {
      due.note = info.relative;
      if (info.overdue) due.tone = 'danger';
      else if (info.relative === 'Today' || info.relative === 'Tomorrow') {
        due.tone = 'warning';
      }
    }
  }
  facts.push(due);

  const parent =
    meta.parent === null ? undefined : ctx.tasksById.get(meta.parent);
  const parentFact: DetailFact = {
    id: 'parent',
    kind: 'plan',
    label: 'Parent',
    value:
      meta.parent === null
        ? 'No parent'
        : (parent?.meta.title ?? 'Unknown task'),
    editable: edit,
    raw: meta.parent,
  };
  if (meta.parent === null) parentFact.tone = 'muted';
  else if (parent !== undefined) parentFact.note = kindLabel(parent.meta.kind);
  facts.push(parentFact);

  if (meta.cycle !== null) {
    facts.push({
      id: 'cycle',
      kind: 'text',
      label: 'Cycle',
      value: meta.cycle.name ?? `Cycle ${meta.cycle.number}`,
      note: `${formatShortDate(meta.cycle.startsAt, ctx.now)} – ${formatShortDate(meta.cycle.endsAt, ctx.now)}`,
      editable: false,
      raw: meta.cycle.id,
    });
  }

  if (meta.creator !== null) {
    facts.push({
      id: 'creator',
      kind: 'person',
      label: 'Creator',
      value: assigneeDisplay(meta.creator, ctx.personFor).label,
      note: `Created ${formatShortDate(meta.created, ctx.now)}`,
      editable: false,
      raw: meta.creator,
    });
  }

  if (meta.risk !== 'routine') {
    const risk: DetailFact = {
      id: 'risk',
      kind: 'text',
      label: 'Risk',
      value: capitalise(meta.risk),
      editable: false,
      raw: meta.risk,
    };
    const tone = RISK_TONE[meta.risk];
    if (tone !== undefined) risk.tone = tone;
    facts.push(risk);
  }

  if (meta.model !== null) {
    facts.push({
      id: 'model',
      kind: 'text',
      label: 'Model',
      value: meta.model,
      editable: false,
      raw: meta.model,
    });
  }

  const selfReview: DetailFact = {
    id: 'selfReview',
    kind: 'switch',
    label: 'Self review',
    value: meta.selfReview ? 'On' : 'Off',
    editable: edit,
    raw: meta.selfReview,
  };
  if (!meta.selfReview) selfReview.tone = 'muted';
  facts.push(selfReview);

  if (meta.exercised) {
    facts.push({
      id: 'exercised',
      kind: 'switch',
      label: 'Verified',
      value: 'Exercised by a verify run',
      tone: 'success',
      editable: false,
      raw: true,
    });
  }

  if (meta.external !== null) {
    const ref = parseLinearExternal(meta.external);
    const link = linearLinkOf(meta.external, ctx);
    const external: DetailFact = {
      id: 'external',
      kind: 'link',
      label: ref === null ? 'External' : 'Linear',
      value:
        link?.identifier ?? (ref === null ? 'Linked' : `Linear ${ref.entity}`),
      editable: false,
      raw: meta.external,
    };
    if (link !== null) external.href = link.url;
    facts.push(external);
  }

  return facts;
}

/* ---- picker choices ----------------------------------------------------- */

/**
 * The StatePicker's choices: the model's statuses in config order, each as
 * its display label and workflow type. A `current` status the model does not
 * define (an older file, a renamed status) is appended so the picker can
 * still show it as chosen.
 */
export function stateChoices(
  model: StatusModel,
  current?: string
): StateChoice[] {
  const choices: StateChoice[] = model.definitions.map((definition) => ({
    id: definition.name,
    name: statusLabel(definition.name),
    kind: definition.type,
  }));
  if (current !== undefined && !choices.some((c) => c.id === current)) {
    choices.push({
      id: current,
      name: statusLabel(current),
      kind: statusType(current, model),
    });
  }
  return choices;
}

/** The AssigneePicker's choices (`buildPersonChoices`): the people, you
 * first, then the agent pool and one choice per executor. */
export function personChoices(ctx: DetailContext): AssigneeChoice[] {
  return buildPersonChoices({
    people: ctx.people,
    executors: ctx.executors,
    me: ctx.me,
  });
}

// A label as the task spells it (`Group/Name`, or the name) as a LabelChoice:
// the id is that spelling, since `labels:` on a task holds the refs.
function labelChoiceOf(
  ref: string,
  definition: LabelDefinition | undefined
): LabelChoice {
  const slash = ref.indexOf('/');
  const group =
    definition?.group != null && definition.group !== ''
      ? definition.group
      : slash > 0
        ? ref.slice(0, slash)
        : null;
  const name = definition?.name ?? (slash > 0 ? ref.slice(slash + 1) : ref);
  const choice: LabelChoice = { id: ref, name };
  if (definition?.color != null) choice.color = definition.color;
  if (group !== null) choice.group = { id: group, name: group };
  return choice;
}

/**
 * The LabelPicker's choices: every label of the catalogue (the project's
 * registry), then the labels in use across the project that the catalogue
 * lacks (`inUse`, the task index's vocabulary: a project without a `labels:`
 * registry still offers what its tasks already carry), then any label the
 * task itself carries that neither knows, so it can be removed. Labels match
 * case-insensitively, as the Linear sync matches them; a `Group/Name` spelling
 * reads as grouped even without a definition.
 */
export function labelChoices(
  catalogue: readonly LabelDefinition[],
  doc: TaskListItem,
  inUse: readonly string[] = []
): LabelChoice[] {
  const choices: LabelChoice[] = [];
  const seen = new Set<string>();
  for (const definition of catalogue) {
    const ref = labelRef(definition);
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(labelChoiceOf(ref, definition));
  }
  for (const ref of [...inUse, ...doc.meta.labels]) {
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(labelChoiceOf(ref, undefined));
  }
  return choices;
}

export interface PlanChoices {
  /** Projects (and initiatives) the task may be filed under. */
  projects: PlanChoice[];
  /** Milestones it may be filed under, grouped by their project. */
  milestones: PlanChoice[];
  /** Issues that already have sub-issues, for a task becoming a sub-issue. */
  issues: PlanChoice[];
}

/**
 * Where the task may move (the ProjectPicker's and MilestonePicker's
 * choices): containers of a broader kind (core's `isValidParentKind`) and,
 * for an issue, issues that already parent others, never itself, anything
 * beneath it (a cycle) or an archived task. A milestone's hint is its due
 * date and its group its project; the rest are hinted by kind.
 */
export function planChoices(
  tasksById: ReadonlyMap<string, TaskListItem>,
  doc: TaskListItem,
  index: Pick<TaskIndex, 'childrenOf' | 'parentIds'>,
  now: Date
): PlanChoices {
  const below = descendantIds(doc.meta.id, index.childrenOf);
  const out: PlanChoices = { projects: [], milestones: [], issues: [] };
  for (const candidate of tasksById.values()) {
    const id = candidate.meta.id;
    if (
      id === doc.meta.id ||
      below.has(id) ||
      candidate.meta.archivedAt !== undefined ||
      !isValidParentKind(doc.meta.kind, candidate.meta.kind)
    ) {
      continue;
    }
    const kind = canonicalKind(candidate.meta.kind);
    const choice: PlanChoice = { id, name: candidate.meta.title };
    if (kind === 'milestone') {
      const due = candidate.meta.dueDate;
      choice.hint =
        due === null
          ? kindLabel('milestone')
          : formatShortDate(calendarDay(due), now);
      const project =
        candidate.meta.parent === null
          ? undefined
          : tasksById.get(candidate.meta.parent);
      if (project !== undefined) choice.group = project.meta.title;
      out.milestones.push(choice);
    } else if (isContainerKind(kind)) {
      choice.hint = kindLabel(candidate.meta.kind);
      out.projects.push(choice);
    } else if (index.parentIds.has(id)) {
      choice.hint = kindLabel(candidate.meta.kind);
      out.issues.push(choice);
    }
  }
  return out;
}

/** Every task below `rootId`, through any depth of `parent` links. */
function descendantIds(
  rootId: string,
  childrenOf: ReadonlyMap<string, readonly TaskListItem[]>
): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const child of childrenOf.get(id) ?? []) {
      if (out.has(child.meta.id)) continue;
      out.add(child.meta.id);
      stack.push(child.meta.id);
    }
  }
  return out;
}

/**
 * The estimate scale: Linear's Fibonacci points, with 0 so "zero points" and
 * "no estimate" stay distinct (owner decision 2026-10-26, Phase 3a: the one
 * fixed scale, the values the old EstimateControl offered plus 0; a current
 * value outside it is listed by EstimatePicker itself).
 */
export const ESTIMATE_SCALE: readonly number[] = [0, 1, 2, 3, 5, 8, 13];

export function estimateChoices(): EstimateChoice[] {
  return ESTIMATE_SCALE.map((value) => ({
    value,
    label: estimateLabel(value),
  }));
}

/* ---- patches ------------------------------------------------------------ */

/** The value each editable fact's control hands back. */
export interface FactValues {
  status: string;
  /** null = nobody. */
  assignee: string | null;
  priority: TaskPriority;
  labels: readonly string[];
  estimate: number | null;
  /** `YYYY-MM-DD`, or null to clear. */
  start: string | null;
  due: string | null;
  parent: string | null;
  selfReview: boolean;
}

export type EditableFactId = keyof FactValues;

function dayOrNull(day: string | null): string | null {
  return day === null || day.trim() === '' ? null : day.slice(0, 10);
}

const PATCH_FOR: {
  [K in EditableFactId]: (next: FactValues[K]) => UpdatePatch;
} = {
  status: (status) => ({ status }),
  assignee: (assignee) => ({
    assignee: assignee === null || assignee === '' ? UNASSIGNED : assignee,
  }),
  priority: (priority) => ({ priority: fromTaskPriority(priority) }),
  labels: (labels) => ({ labels: [...labels] }),
  estimate: (estimate) => ({ estimate }),
  start: (startDate) => ({ startDate: dayOrNull(startDate) }),
  due: (dueDate) => ({ dueDate: dayOrNull(dueDate) }),
  parent: (parent) => ({ parent }),
  selfReview: (selfReview) => ({ selfReview }),
};

/**
 * The UpdatePatch a control's new value writes: a status id, an assignee
 * ref (null → `none`), the table's priority back to Dispatch's word, the
 * complete label list, an estimate or null, a `YYYY-MM-DD` day or null for
 * either date, a parent id or null, the self-review switch.
 */
export function patchFor<K extends EditableFactId>(
  id: K,
  next: FactValues[K]
): UpdatePatch {
  const build = PATCH_FOR[id] as (next: FactValues[K]) => UpdatePatch;
  return build(next);
}

/* ---- relations ---------------------------------------------------------- */

/** One related task, before the view adds its links and buttons. */
export interface RelationModel {
  /** The other task's id. */
  id: string;
  taskKey: string;
  title: string;
  href: string;
  state: TaskDetailStatus;
  /** The assignee's name, null for nobody; absent for a task the window
   * does not know. */
  assignee?: string | null;
  /** Where it lives ("Atlas / Dual-write"), when it sits under containers. */
  context?: string;
  /** Done or canceled: no longer blocking. */
  resolved: boolean;
  /** The id names no task the window knows (deleted, or another project). */
  missing?: boolean;
}

export interface DetailRelations {
  blockedBy: RelationModel[];
  /** Tasks that name this one in their `blockedBy`. */
  blocks: RelationModel[];
  related: RelationModel[];
  duplicateOf: RelationModel | null;
}

function relationOf(id: string, ctx: DetailContext): RelationModel {
  const other = ctx.tasksById.get(id);
  if (other === undefined) {
    return {
      id,
      taskKey: id,
      title: 'Unknown task',
      href: ctx.hrefFor(id),
      state: { kind: 'backlog', label: 'Unknown' },
      resolved: false,
      missing: true,
    };
  }
  return relationFor(other, ctx);
}

function relationFor(other: TaskListItem, ctx: DetailContext): RelationModel {
  const { meta } = other;
  const out: RelationModel = {
    id: meta.id,
    taskKey: taskKeyOf(other, ctx),
    title: meta.title,
    href: ctx.hrefFor(meta.id),
    state: stateOf(meta.status, ctx.model),
    assignee:
      assigneeRef(meta.assignee) === null
        ? null
        : assigneeDisplay(meta.assignee, ctx.personFor).label,
    resolved: isDoneStatus(meta.status, ctx.model),
  };
  const containers = ancestorsOf(other, ctx.tasksById).filter((ancestor) =>
    isContainerKind(ancestor.meta.kind)
  );
  if (containers.length > 0) {
    out.context = containers.map((c) => c.meta.title).join(' / ');
  }
  return out;
}

/**
 * The task's links to other tasks: what it waits on (its own `blockedBy`,
 * a dangling id kept as a missing row), what waits on it (from the index),
 * its related tasks and the task it duplicates. Each row carries the other
 * task's key, state, assignee and containers, and whether it is done.
 */
export function buildDetailRelations(
  doc: TaskListItem,
  ctx: DetailContext
): DetailRelations {
  const { meta } = doc;
  return {
    blockedBy: meta.blockedBy.map((id) => relationOf(id, ctx)),
    blocks: blocksIn(ctx.index, meta.id).map((other) =>
      relationFor(other, ctx)
    ),
    related: meta.relatedTo.map((id) => relationOf(id, ctx)),
    duplicateOf:
      meta.duplicateOf === null ? null : relationOf(meta.duplicateOf, ctx),
  };
}

/** Why a relation cannot be added: the task itself, one already linked, an
 * id naming no task, or (blockers only) a dependency cycle. */
export type RelationError = 'self' | 'duplicate' | 'cycle' | 'missing';

export type RelationPatch = { patch: UpdatePatch } | { error: RelationError };

function linkError(
  doc: TaskListItem,
  otherId: string,
  linked: readonly string[],
  tasksById: ReadonlyMap<string, TaskListItem>
): RelationError | null {
  if (otherId === doc.meta.id) return 'self';
  if (linked.includes(otherId)) return 'duplicate';
  if (!tasksById.has(otherId)) return 'missing';
  return null;
}

/**
 * The patch that adds a blocker, or why it cannot be added: itself, one it
 * already waits on, an id the window does not know, or a cycle (core's
 * `findDependencyCycles` over the task list as it would be, counting only a
 * cycle that passes through this task: a cycle elsewhere is `doctor`'s
 * business, not a reason to refuse an unrelated link).
 */
export function blockerAddPatch(
  doc: TaskListItem,
  blockerId: string,
  tasksById: ReadonlyMap<string, TaskListItem>
): RelationPatch {
  const error = linkError(doc, blockerId, doc.meta.blockedBy, tasksById);
  if (error !== null) return { error };
  const blockedBy = [...doc.meta.blockedBy, blockerId];
  const wouldBe: TaskListItem = { meta: { ...doc.meta, blockedBy } };
  const tasks = [...tasksById.values()].map((t) =>
    t.meta.id === doc.meta.id ? wouldBe : t
  );
  if (!tasksById.has(doc.meta.id)) tasks.push(wouldBe);
  const cycles = findDependencyCycles(tasks);
  if (cycles.some((cycle) => cycle.includes(doc.meta.id))) {
    return { error: 'cycle' };
  }
  return { patch: { blockedBy } };
}

/** The patch that stops waiting on `blockerId`. */
export function blockerRemovePatch(
  doc: TaskListItem,
  blockerId: string
): UpdatePatch {
  return { blockedBy: doc.meta.blockedBy.filter((id) => id !== blockerId) };
}

/**
 * Removing a "blocks" row edits the other task: `otherDoc` stops naming
 * `thisId` in its `blockedBy`. Returns whom to patch along with the patch.
 */
export function blocksRemovePatch(
  otherDoc: TaskListItem,
  thisId: string
): { taskId: string; patch: UpdatePatch } {
  return {
    taskId: otherDoc.meta.id,
    patch: blockerRemovePatch(otherDoc, thisId),
  };
}

/** The patch that adds a related task, or why it cannot be added (no cycle
 * check: the relation is symmetric and orders nothing). */
export function relatedAddPatch(
  doc: TaskListItem,
  otherId: string,
  tasksById: ReadonlyMap<string, TaskListItem>
): RelationPatch {
  const error = linkError(doc, otherId, doc.meta.relatedTo, tasksById);
  if (error !== null) return { error };
  return { patch: { relatedTo: [...doc.meta.relatedTo, otherId] } };
}

export function relatedRemovePatch(
  doc: TaskListItem,
  otherId: string
): UpdatePatch {
  return { relatedTo: doc.meta.relatedTo.filter((id) => id !== otherId) };
}

/** The patch that marks the task a duplicate of `otherId`, or clears the
 * mark with null; a task cannot duplicate itself or an unknown task. */
export function duplicateOfPatch(
  doc: TaskListItem,
  otherId: string | null,
  tasksById: ReadonlyMap<string, TaskListItem>
): RelationPatch {
  if (otherId === null) return { patch: { duplicateOf: null } };
  if (otherId === doc.meta.id) return { error: 'self' };
  if (otherId === doc.meta.duplicateOf) return { error: 'duplicate' };
  if (!tasksById.has(otherId)) return { error: 'missing' };
  return { patch: { duplicateOf: otherId } };
}

/** How many tasks the relation picker's search answers with. */
const RELATION_SEARCH_LIMIT = 20;

// How well a task's key or id matches the typed text: exactly, as a prefix,
// or somewhere inside; null when neither does.
function keyRank(needle: string, key: string, id: string): number | null {
  const k = key.toLowerCase();
  const i = id.toLowerCase();
  if (k === needle || i === needle) return 0;
  if (k.startsWith(needle) || i.startsWith(needle)) return 1;
  if (k.includes(needle) || i.includes(needle)) return 2;
  return null;
}

/**
 * The relation picker's search over the window's tasks: by key or id (exact
 * first, then prefix, then containing, so "24" finds ENG-24) and by title,
 * labels and id (every word, `matchesIssueSearch`). Open tasks before closed
 * ones, then list order; an empty query lists open tasks in list order.
 * Archived tasks and `exclude` (the task itself, tasks already linked) are
 * never offered. At most `limit` hits.
 */
export function relationSearch(
  query: string,
  ctx: DetailContext,
  exclude: ReadonlySet<string>,
  limit = RELATION_SEARCH_LIMIT
): TaskSearchResult[] {
  const needle = query.trim().toLowerCase();
  const words = searchWords(query);
  const hits: {
    doc: TaskListItem;
    key: string;
    rank: number;
    open: boolean;
    order: number;
  }[] = [];
  let order = 0;
  for (const doc of ctx.tasksById.values()) {
    order += 1;
    const id = doc.meta.id;
    if (exclude.has(id) || doc.meta.archivedAt !== undefined) continue;
    const open = !isDoneStatus(doc.meta.status, ctx.model);
    const key = taskKeyOf(doc, ctx);
    let rank: number | null;
    if (needle === '') {
      if (!open) continue;
      rank = 3;
    } else {
      rank = keyRank(needle, key, id);
      if (rank === null && matchesIssueSearch(doc, words, key)) rank = 3;
    }
    if (rank === null) continue;
    hits.push({ doc, key, rank, open, order });
  }
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.open !== b.open) return a.open ? -1 : 1;
    return a.order - b.order;
  });
  return hits.slice(0, limit).map(({ doc, key }) => ({
    id: doc.meta.id,
    taskKey: key,
    title: doc.meta.title,
    state: stateOf(doc.meta.status, ctx.model),
  }));
}

/* ---- description -------------------------------------------------------- */

export interface DetailDescription {
  description: string;
  /** The Acceptance Criteria section as written. */
  acceptance: string;
  /** One criterion per line of it, bullets and boxes stripped. */
  criteria: string[];
  amendments: string;
}

/** The body's sections as the page reads them (`parseTaskSections`): the
 * description, the acceptance criteria (and each criterion), the amendments. */
export function buildDetailDescription(doc: TaskDoc): DetailDescription {
  const sections = parseTaskSections(doc.body);
  const acceptance = sections.get('Acceptance Criteria') ?? '';
  return {
    description: sections.get('Description') ?? '',
    acceptance,
    criteria: criteriaItems(acceptance),
    amendments: sections.get('Amendments') ?? '',
  };
}

/** The patch that replaces the `## Description` section. */
export function descriptionPatch(text: string): UpdatePatch {
  return { description: text };
}

/** The patch that replaces the `## Acceptance Criteria` section. */
export function acceptancePatch(text: string): UpdatePatch {
  return { acceptanceCriteria: text };
}

/* ---- comments ----------------------------------------------------------- */

/** One comment as TaskCommentList draws it, plus what the host's own
 * controls need: whose it is and what it answers. */
export interface DetailComment extends UiTaskComment {
  /** This person may edit or delete it: their own, or one of their agents'
   * (the daemon's rule, `canModifyComment`); never while still pending. */
  own: boolean;
  parentId: string | null;
  /** Added here and not yet confirmed by the daemon. */
  pending: boolean;
}

function commentModel(
  comment: TaskComment,
  reply: boolean,
  ctx: DetailContext
): DetailComment {
  const pending = isPendingComment(comment);
  const who = assigneeDisplay(comment.author, ctx.personFor);
  const out: DetailComment = {
    id: comment.id,
    author: who.label,
    at: relativeTime(comment.created, ctx.now),
    dateTime: comment.created,
    body: comment.body,
    own: !pending && canModifyComment(comment.author, ctx.me),
    parentId: comment.parentId,
    pending,
  };
  if (reply) out.reply = true;
  // An agent's comment is a bot's: quiet, as the planner draws Linear's.
  if (who.isAgent) out.tone = 'muted';
  return out;
}

/**
 * The thread as one flat list, oldest first, each top-level comment followed
 * by its replies (`commentThreads`), authored by the registry's name for the
 * person (else the ref's handle), dated relative to `now`.
 */
export function buildDetailComments(
  comments: readonly TaskComment[],
  ctx: DetailContext
): DetailComment[] {
  const out: DetailComment[] = [];
  for (const thread of commentThreads(comments)) {
    out.push(commentModel(thread.root, false, ctx));
    for (const reply of thread.replies) {
      out.push(commentModel(reply, true, ctx));
    }
  }
  return out;
}

/* ---- activity ----------------------------------------------------------- */

export interface DetailActivityInput {
  doc: TaskDoc;
  /** The task's runs, any order. */
  runs: readonly RunMeta[];
  now: Date;
  /** Names the actor an Activity line is credited to. */
  personFor: (assignee: string) => { name: string } | undefined;
}

// A line's colour by what it records (§8.2): a failure red, a merge green,
// motion (a dispatch, a PR) blue, a discard or stop grey, the rest neutral.
const TIMELINE_TONE: Partial<Record<TimelineKind, UiTone>> = {
  dispatched: 'info',
  pr: 'info',
  failed: 'danger',
  merged: 'success',
  discarded: 'muted',
  stopped: 'muted',
};

const RUN_TAG = /^\[run ([^\]]+)\]/;

interface Dated {
  /** The instant, or null for an undated note (listed last, in order). */
  at: string | null;
  item: TaskActivityItem;
}

// A run the Activity section never mentioned (an older task, a lost line),
// worded from the run itself: live runs in blue, a merge green, a failure
// red, a discard or cancel grey.
function runItem(run: RunMeta, now: Date): Dated {
  const base = { id: `run-${run.id}`, at: '' };
  if (!isTerminalRunState(run.state)) {
    const doing =
      run.state === 'awaiting-approval'
        ? 'awaiting approval'
        : run.state === 'provisioning'
          ? 'provisioning'
          : 'running';
    return {
      at: run.createdAt,
      item: {
        ...base,
        at: relativeTime(run.createdAt, now),
        dateTime: run.createdAt,
        label: `Run ${run.id} ${doing} on ${run.executor}`,
        tone: 'info',
      },
    };
  }
  let label: string;
  let tone: UiTone | undefined;
  let at = run.updatedAt;
  let detail: string | undefined = `Ran on ${run.executor}.`;
  if (run.reviewedAt !== undefined) {
    at = run.reviewedAt;
    if (run.reviewAction === 'discard') {
      label = `Run ${run.id} discarded`;
      tone = 'muted';
    } else if (run.reviewAction === 'merge' || run.reviewAction === 'pr') {
      label = `Run ${run.id} merged`;
      tone = 'success';
    } else {
      label = `Run ${run.id} closed`;
    }
  } else if (run.state === 'failed' || run.state === 'interrupted-dirty') {
    label =
      run.state === 'failed'
        ? `Run ${run.id} failed`
        : `Run ${run.id} interrupted`;
    tone = 'danger';
    const error = (run.error ?? '').trim();
    if (error !== '') detail = error;
  } else if (run.state === 'cancelled') {
    label = `Run ${run.id} cancelled`;
    tone = 'muted';
  } else {
    label = `Run ${run.id} finished`;
  }
  const item: TaskActivityItem = {
    ...base,
    at: relativeTime(at, now),
    dateTime: at,
    label,
    detail,
  };
  if (tone !== undefined) item.tone = tone;
  return { at, item };
}

/**
 * The task's history, newest first: every `## Activity` line as the
 * timeline reads it (its routing tag dropped, classified for its tone, the
 * actor it is credited to as the detail), plus one item for each run no
 * line mentions. Undated notes follow the dated items in their written
 * order.
 */
export function buildDetailActivity(
  input: DetailActivityInput
): TaskActivityItem[] {
  const { doc, runs, now } = input;
  const entries = parseActivity(
    parseTaskSections(doc.body).get('Activity') ?? ''
  );
  const mentioned = new Set<string>();
  for (const entry of entries) {
    const tag = RUN_TAG.exec(entry.text);
    if (tag?.[1] !== undefined) mentioned.add(tag[1]);
  }
  const dated: Dated[] = taskTimeline(entries).map((line, index) => {
    const item: TaskActivityItem = {
      id: `line-${index}`,
      at: line.at === null ? 'Undated' : relativeTime(line.at, now),
      label: capitalise(line.text),
    };
    if (line.at !== null) item.dateTime = line.at;
    if (line.actor !== null && line.actor !== 'none') {
      item.detail = `By ${assigneeDisplay(line.actor, input.personFor).label}.`;
    }
    const tone = TIMELINE_TONE[line.kind];
    if (tone !== undefined) item.tone = tone;
    return { at: line.at, item };
  });
  for (const run of runs) {
    if (!mentioned.has(run.id)) dated.push(runItem(run, now));
  }
  const timed = dated.filter((d) => d.at !== null);
  const undated = dated.filter((d) => d.at === null);
  timed.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''));
  return [...timed, ...undated].map((d) => d.item);
}
