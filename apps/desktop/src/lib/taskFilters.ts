import type { RunState } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';

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
  | 'epic'
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

export const TASK_FILTERS_V2_STORAGE_KEY = 'dispatch:tasks-filters-v2';

export const EMPTY_TASK_FILTER_SET: TaskFilterSet = {
  clauses: [],
  join: 'and',
};

/** The value a scalar facet uses for "nothing set" — no epic, no milestone, no live run. */
export const FILTER_NONE = 'none';

export const FILTER_FACETS: readonly FilterFacet[] = [
  'status',
  'priority',
  'assignee',
  'labels',
  'epic',
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
  epic: 'Epic',
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

function parseClause(value: unknown): FilterClause | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isFacet(record.facet)) return null;
  const values = Array.isArray(record.values)
    ? record.values.filter((v): v is string => typeof v === 'string')
    : [];
  if (values.length === 0) return null;
  return {
    facet: record.facet,
    op: isOp(record.op) ? record.op : defaultOpFor(record.facet),
    values,
  };
}

/** The object walk behind `parseTaskFilterSet`, exposed so a filter set nested inside another
 * payload (a saved view) parses the same way: unknown facets and empty clauses drop, a bad
 * `join` reads as `and`. `null` for anything that is not a plain object. */
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
  /** Epic titles by id, for the chip label only. */
  epicTitleById?: ReadonlyMap<string, string>;
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
    case 'epic':
      return doc.meta.parent ?? FILTER_NONE;
    case 'milestone':
      return doc.meta.milestone ?? FILTER_NONE;
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

/** A clause value as a person reads it: `In progress`, `Urgent`, an epic's title. */
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
    case 'epic':
      return value === FILTER_NONE
        ? 'No epic'
        : (ctx.epicTitleById?.get(value) ?? value);
    case 'milestone':
      return value === FILTER_NONE ? 'No milestone' : value;
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
