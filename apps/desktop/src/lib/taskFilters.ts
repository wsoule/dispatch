import type {
  Assignee,
  Priority,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import { ApiError, type RunState } from '@dispatch/client';

import { formatShortDate } from './taskDates';
import { assigneeLabel, priorityLabel, statusLabel } from './taskDisplay';
import { parseTaskFilters } from './tasksPrefs';

/**
 * The Tasks page's filter model (Linear's Filter menu, §7): a list of clauses — one facet,
 * one operator, the values it names — joined by `and` or `or`, applied before grouping on
 * every layout. Persisted under `dispatch:tasks-filters-v2`; the v1 `{ statuses, priorities }`
 * chip shape migrates into `is` clauses on first read so nobody loses an active filter.
 */

export type FilterFacet =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'milestone'
  | 'run'
  | 'created'
  | 'updated';

/** `is`/`is not` compare a scalar facet against the clause's values (any match); `includes`
 * is the label facet's "has every one of these"; `before`/`after` take one ISO date. */
export type FilterOp = 'is' | 'is not' | 'includes' | 'before' | 'after';

export interface FilterClause {
  facet: FilterFacet;
  op: FilterOp;
  values: string[];
}

export type FilterJoin = 'and' | 'or';

export interface TaskFilterSet {
  clauses: FilterClause[];
  join: FilterJoin;
}

export const EMPTY_TASK_FILTER_SET: TaskFilterSet = {
  clauses: [],
  join: 'and',
};

/** The value a scalar facet uses for "nothing set" — no milestone, no live run. */
export const FILTER_NONE = 'none';

export const FILTER_FACETS: readonly FilterFacet[] = [
  'status',
  'priority',
  'assignee',
  'labels',
  'milestone',
  'run',
  'created',
  'updated',
];

const FACET_LABEL: Record<FilterFacet, string> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  labels: 'Labels',
  milestone: 'Milestone',
  run: 'Run state',
  created: 'Created',
  updated: 'Updated',
};

export function facetLabel(facet: FilterFacet): string {
  return FACET_LABEL[facet];
}

const OPS: readonly FilterOp[] = [
  'is',
  'is not',
  'includes',
  'before',
  'after',
];

/** The operator a facet's menu applies when you pick a value: labels accumulate
 * (`includes`), dates compare (`after`), everything else matches (`is`). */
export function defaultOpFor(facet: FilterFacet): FilterOp {
  if (facet === 'labels') return 'includes';
  if (facet === 'created' || facet === 'updated') return 'after';
  return 'is';
}

function isFacet(value: unknown): value is FilterFacet {
  return (
    typeof value === 'string' &&
    (FILTER_FACETS as readonly string[]).includes(value)
  );
}

function isOp(value: unknown): value is FilterOp {
  return (
    typeof value === 'string' && (OPS as readonly string[]).includes(value)
  );
}

/**
 * A facet as stored. Filter sets written before the epic -> milestone rename
 * say `epic` for what the `milestone` facet now matches (a task's parent
 * container, by id), so an `epic` clause reads as a `milestone` one, the way
 * `tasksDisplayFromValue` (lib/tasksPrefs.ts) migrates the display store.
 */
function storedFacet(raw: unknown): unknown {
  return raw === 'epic' ? 'milestone' : raw;
}

function parseClause(value: unknown): FilterClause | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const facet = storedFacet(record.facet);
  if (!isFacet(facet)) return null;
  const values = Array.isArray(record.values)
    ? record.values.filter((v): v is string => typeof v === 'string')
    : [];
  if (values.length === 0) return null;
  return {
    facet,
    op: isOp(record.op) ? record.op : defaultOpFor(facet),
    values,
  };
}

/** The object walk behind `parseTaskFilterSet`, exposed so a filter set nested inside another
 * payload (a saved view) parses the same way: a stored `epic` facet reads as `milestone`,
 * unknown facets and empty clauses drop, a bad `join` reads as `and`. `null` for anything
 * that is not a plain object. */
export function taskFilterSetFromValue(value: unknown): TaskFilterSet | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const clauses = Array.isArray(record.clauses)
    ? record.clauses
        .map(parseClause)
        .filter((c): c is FilterClause => c !== null)
    : [];
  return {
    clauses,
    join: record.join === 'or' ? 'or' : 'and',
  };
}

/** Reads the v2 payload, falling back to a migration of the v1 chip shape (`statuses`,
 * `priorities`) when no v2 value has been written yet. Anything malformed lands on the
 * empty set — a bad preference must never break the Tasks page. */
export function parseTaskFilterSet(
  storedV2: string | null,
  legacyV1: string | null = null
): TaskFilterSet {
  if (storedV2 !== null) {
    try {
      const filters = taskFilterSetFromValue(JSON.parse(storedV2));
      if (filters !== null) return filters;
    } catch {
      // Fall through to the legacy shape, then the empty set.
    }
  }
  return migrateLegacyFilters(legacyV1);
}

/** The v1 chip shape as clauses: every active status becomes one `Status is …` clause,
 * every active priority one `Priority is …`, joined by `and` (the v1 semantics). */
export function migrateLegacyFilters(legacyV1: string | null): TaskFilterSet {
  if (legacyV1 === null) return EMPTY_TASK_FILTER_SET;
  const legacy = parseTaskFilters(legacyV1);
  const clauses: FilterClause[] = [];
  if (legacy.statuses.length > 0) {
    clauses.push({ facet: 'status', op: 'is', values: legacy.statuses });
  }
  if (legacy.priorities.length > 0) {
    clauses.push({ facet: 'priority', op: 'is', values: legacy.priorities });
  }
  return clauses.length === 0
    ? EMPTY_TASK_FILTER_SET
    : { clauses, join: 'and' };
}

/** The storage payload, in a fixed field order so two equal sets always serialize to the
 * same string — `savedViews.ts` compares these strings. */
export function serializeTaskFilterSet(filters: TaskFilterSet): string {
  return JSON.stringify({
    clauses: filters.clauses.map((c) => ({
      facet: c.facet,
      op: c.op,
      values: c.values,
    })),
    join: filters.join,
  });
}

export function hasActiveTaskFilters(filters: TaskFilterSet): boolean {
  return filters.clauses.length > 0;
}

/** Adds `value` to the clause for `facet` (creating it with the facet's default operator),
 * or removes it when already there; a clause left with no values is dropped. Returns a new
 * set; never mutates. */
export function toggleFilterValue(
  filters: TaskFilterSet,
  facet: FilterFacet,
  value: string
): TaskFilterSet {
  const index = filters.clauses.findIndex((c) => c.facet === facet);
  if (index === -1) {
    return {
      ...filters,
      clauses: [
        ...filters.clauses,
        { facet, op: defaultOpFor(facet), values: [value] },
      ],
    };
  }
  const clause = filters.clauses[index];
  const values = clause.values.includes(value)
    ? clause.values.filter((v) => v !== value)
    : [...clause.values, value];
  const clauses = filters.clauses.slice();
  if (values.length === 0) clauses.splice(index, 1);
  else clauses[index] = { ...clause, values };
  return { ...filters, clauses };
}

/** Replaces the date clause for `facet` outright — a date facet holds one value. */
export function setDateFilter(
  filters: TaskFilterSet,
  facet: 'created' | 'updated',
  op: 'before' | 'after',
  isoDate: string
): TaskFilterSet {
  const clauses = filters.clauses.filter((c) => c.facet !== facet);
  return {
    ...filters,
    clauses: [...clauses, { facet, op, values: [isoDate] }],
  };
}

export function removeFilterClause(
  filters: TaskFilterSet,
  index: number
): TaskFilterSet {
  return {
    ...filters,
    clauses: filters.clauses.filter((_, i) => i !== index),
  };
}

export function setFilterJoin(
  filters: TaskFilterSet,
  join: FilterJoin
): TaskFilterSet {
  return { ...filters, join };
}

/** Flips a clause between `is` and `is not` (the chip's operator toggle); other operators
 * are left alone. */
export function toggleClauseNegation(
  filters: TaskFilterSet,
  index: number
): TaskFilterSet {
  const clause = filters.clauses[index];
  if (clause === undefined || (clause.op !== 'is' && clause.op !== 'is not')) {
    return filters;
  }
  const clauses = filters.clauses.slice();
  clauses[index] = { ...clause, op: clause.op === 'is' ? 'is not' : 'is' };
  return { ...filters, clauses };
}

export interface FilterContext {
  /** Live (non-terminal) run state per task id, for the `Run state` facet. */
  liveRunStateByTaskId?: ReadonlyMap<string, RunState>;
  /** Milestone titles by id, for the chip label only. */
  milestoneTitleById?: ReadonlyMap<string, string>;
}

// A scalar facet's value on one task, as the string the clause's values are compared with.
function scalarValue(
  doc: TaskListItem,
  facet: Exclude<FilterFacet, 'labels' | 'created' | 'updated'>,
  ctx: FilterContext
): string {
  switch (facet) {
    case 'status':
      return doc.meta.status;
    case 'priority':
      return doc.meta.priority;
    case 'assignee':
      return doc.meta.assignee;
    case 'milestone':
      return doc.meta.parent ?? FILTER_NONE;
    case 'run':
      return ctx.liveRunStateByTaskId?.get(doc.meta.id) ?? FILTER_NONE;
  }
}

/** Whether one task satisfies one clause. */
function matchesClause(
  doc: TaskListItem,
  clause: FilterClause,
  ctx: FilterContext = {}
): boolean {
  switch (clause.facet) {
    case 'labels': {
      const has = (label: string) => doc.meta.labels.includes(label);
      if (clause.op === 'is not') return !clause.values.some(has);
      if (clause.op === 'includes') return clause.values.every(has);
      return clause.values.some(has);
    }
    case 'created':
    case 'updated': {
      const stamp = Date.parse(doc.meta[clause.facet]);
      const bound = Date.parse(clause.values[0] ?? '');
      if (Number.isNaN(stamp) || Number.isNaN(bound)) return false;
      return clause.op === 'before' ? stamp < bound : stamp > bound;
    }
    default: {
      const hit = clause.values.includes(scalarValue(doc, clause.facet, ctx));
      return clause.op === 'is not' ? !hit : hit;
    }
  }
}

/** Whether one task passes the whole set: every clause under `and`, any under `or`. An
 * empty set passes everything. */
export function matchesTaskFilterSet(
  doc: TaskListItem,
  filters: TaskFilterSet,
  ctx: FilterContext = {}
): boolean {
  if (filters.clauses.length === 0) return true;
  const test = (clause: FilterClause) => matchesClause(doc, clause, ctx);
  return filters.join === 'or'
    ? filters.clauses.some(test)
    : filters.clauses.every(test);
}

/** The tasks that pass. Returns the same array when nothing is active, so callers keep
 * referential stability on the common unfiltered path. */
export function applyTaskFilters(
  tasks: TaskListItem[],
  filters: TaskFilterSet,
  ctx: FilterContext = {}
): TaskListItem[] {
  if (filters.clauses.length === 0) return tasks;
  return tasks.filter((doc) => matchesTaskFilterSet(doc, filters, ctx));
}

const RUN_STATE_LABEL: Record<RunState, string> = {
  provisioning: 'Provisioning',
  running: 'Working',
  'awaiting-approval': 'Awaiting approval',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  'interrupted-dirty': 'Interrupted',
};

/** A clause value as a person reads it: `In progress`, `Urgent`, a milestone's title. */
export function filterValueLabel(
  facet: FilterFacet,
  value: string,
  ctx: FilterContext = {}
): string {
  switch (facet) {
    case 'status':
      return statusLabel(value);
    case 'priority':
      return priorityLabel(value as TaskListItem['meta']['priority']);
    case 'assignee':
      return assigneeLabel(value);
    case 'milestone':
      return value === FILTER_NONE
        ? 'No milestone'
        : (ctx.milestoneTitleById?.get(value) ?? value);
    case 'run':
      return value === FILTER_NONE
        ? 'No live run'
        : (RUN_STATE_LABEL[value as RunState] ?? value);
    case 'created':
    case 'updated':
      return formatShortDate(value);
    case 'labels':
      return value;
  }
}

/** The three spans of an applied-filter chip — `Status` / `is` / `In progress`, `Labels` /
 * `includes` / `ui, api`, `Created` / `after` / `Sep 1` — kept apart so the chip can make
 * the operator interactive; joined with spaces they read as the sentence. */
export function clauseParts(
  clause: FilterClause,
  ctx: FilterContext = {}
): { facet: string; op: FilterOp; values: string } {
  return {
    facet: facetLabel(clause.facet),
    op: clause.op,
    values: clause.values
      .map((v) => filterValueLabel(clause.facet, v, ctx))
      .join(', '),
  };
}

// ---- The Filter picker's vocabulary --------------------------------------------------
// What `components/issues/FilterPicker.tsx` lists, kept here as plain data so it is
// unit-tested without React: the values each facet offers, the date quick picks and their
// bounds, the search match and the AI filter's error sentence. No JSX: a value's glyph is a
// `FilterOptionMark` the component turns into a picker mark.

/** The values the Filter picker offers, from the project's own vocabulary. */
export interface FilterPickerContext {
  /** The project's statuses in config order. */
  statuses: readonly string[];
  /** Every container a task can sit under (a milestone, project, parent issue…). */
  milestones: readonly TaskListItem[];
  /** Every label in use, sorted. */
  labels: readonly string[];
}

const PRIORITIES: readonly Priority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];
const ASSIGNEES: readonly Assignee[] = ['agent', 'human', 'none'];
const RUN_STATES: readonly (RunState | typeof FILTER_NONE)[] = [
  'running',
  'provisioning',
  'awaiting-approval',
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
  FILTER_NONE,
];

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The facets that hold one date bound rather than a list of values. */
export type DateFacet = 'created' | 'updated';

export function isDateFacet(facet: FilterFacet): facet is DateFacet {
  return facet === 'created' || facet === 'updated';
}

export interface DatePick {
  label: string;
  op: 'before' | 'after';
  days: number;
}

/** The Dates facets take one bound; these are the quick picks a menu can offer without a
 * date input: `days` ago from now, `before` or `after`. A pick's value is `op:days`. */
export const DATE_PICKS: readonly DatePick[] = [
  { label: 'In the last day', op: 'after', days: 1 },
  { label: 'In the last week', op: 'after', days: 7 },
  { label: 'In the last month', op: 'after', days: 30 },
  { label: 'More than a week ago', op: 'before', days: 7 },
  { label: 'More than a month ago', op: 'before', days: 30 },
];

/** The glyph a value carries, as data: a status's state ring, a priority's bars, or an
 * assignee's avatar (a blank name is the dashed "nobody" avatar). */
export type FilterOptionMark =
  | { kind: 'state'; status: string }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'avatar'; name: string };

/** One value a facet can filter on. */
export interface FilterOption {
  value: string;
  label: string;
  mark?: FilterOptionMark;
}

/** Every value a facet can filter on, from the project's own vocabulary, in menu order. */
export function optionsFor(
  facet: FilterFacet,
  ctx: FilterPickerContext
): FilterOption[] {
  switch (facet) {
    case 'status':
      return ctx.statuses.map((s) => ({
        value: s,
        label: filterValueLabel('status', s),
        mark: { kind: 'state', status: s },
      }));
    case 'priority':
      return PRIORITIES.map((p) => ({
        value: p,
        label: filterValueLabel('priority', p),
        mark: { kind: 'priority', priority: p },
      }));
    case 'assignee':
      return ASSIGNEES.map((a) => {
        const label = filterValueLabel('assignee', a);
        return {
          value: a,
          label,
          mark: { kind: 'avatar', name: a === FILTER_NONE ? '' : label },
        };
      });
    case 'labels':
      return ctx.labels.map((l) => ({ value: l, label: l }));
    case 'milestone':
      return [
        { value: FILTER_NONE, label: 'No milestone' },
        ...ctx.milestones.map((m) => ({
          value: m.meta.id,
          label: m.meta.title,
        })),
      ];
    case 'run':
      return RUN_STATES.map((s) => ({
        value: s,
        label: filterValueLabel('run', s),
      }));
    case 'created':
    case 'updated':
      return DATE_PICKS.map((pick) => ({
        value: `${pick.op}:${pick.days}`,
        label: pick.label,
      }));
  }
}

/** The picker's search: `text` contains the trimmed query, ignoring case. */
export function matches(query: string, text: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

/** How many values the facet's clause holds (0 without one): the facet row's count. */
export function selectedCount(
  filters: TaskFilterSet,
  facet: FilterFacet
): number {
  return filters.clauses.find((c) => c.facet === facet)?.values.length ?? 0;
}

/**
 * Which quick pick a date clause shows as chosen. The clause stores a resolved ISO bound, so
 * it cannot match a pick on value: the chosen pick is the one with the clause's operator
 * whose `days` is nearest to how old the bound is at `now` (the bound was "then minus
 * `days`" when it was picked). Null without a clause or with an unreadable bound.
 */
export function pickedDateValue(
  filters: TaskFilterSet,
  facet: DateFacet,
  now: number
): string | null {
  const clause = filters.clauses.find((c) => c.facet === facet);
  const bound = Date.parse(clause?.values[0] ?? '');
  if (clause === undefined || Number.isNaN(bound)) return null;
  const ageDays = (now - bound) / DAY_MS;
  const nearest = DATE_PICKS.filter((pick) => pick.op === clause.op).sort(
    (a, b) => Math.abs(a.days - ageDays) - Math.abs(b.days - ageDays)
  )[0];
  return nearest === undefined ? null : `${nearest.op}:${nearest.days}`;
}

/** A quick pick's value (`after:7`) as the clause it stores: its operator and the ISO bound
 * `days` before `now`. */
export function datePickBound(
  value: string,
  now: number
): { op: 'before' | 'after'; bound: string } {
  const [op, days] = value.split(':');
  return {
    op: op === 'before' ? 'before' : 'after',
    bound: new Date(now - Number(days) * DAY_MS).toISOString(),
  };
}

/** Applies a quick pick to the date facet, replacing whatever bound it held. */
export function applyDatePick(
  filters: TaskFilterSet,
  facet: DateFacet,
  value: string,
  now: number
): TaskFilterSet {
  const { op, bound } = datePickBound(value, now);
  return setDateFilter(filters, facet, op, bound);
}

/** What the AI filter shows under its input when the daemon says no: an old daemon has no
 * route (404), anything else carries its own message. */
export function aiFilterErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return 'Update the daemon to use AI filters';
  }
  return err instanceof Error && err.message !== ''
    ? err.message
    : 'AI filter failed';
}
