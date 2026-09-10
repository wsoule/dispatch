import type { TaskDoc } from '@dispatch/core/browser';

/**
 * The Tasks page's persisted display preferences: the status/priority filter chips, the
 * board's column visibility, and the list's column visibility. All parsed defensively from
 * localStorage — a bad or stale payload falls back to defaults rather than throwing during
 * render.
 */

export interface TaskFilters {
  /** Statuses the chip row has active — empty means "no filter", everything passes. */
  statuses: string[];
  /** Priorities the chip row has active — same empty-means-all semantics. */
  priorities: string[];
}

export interface BoardColumnPrefs {
  /** Hide status columns that currently hold zero cards (default on) — the fix for a
   * 7-status board that renders two viewport-widths of mostly-empty columns. */
  hideEmpty: boolean;
  /** Statuses explicitly hidden regardless of count. */
  hidden: string[];
  /** One lane per milestone instead of the flat board (default off): the lane-per-milestone
   * matrix is sparse — most lanes fill one column — so the dense flat kanban is the default
   * and the Milestones view is the per-milestone surface. */
  groupByEpic: boolean;
}

export const TASK_FILTERS_STORAGE_KEY = 'dispatch:tasks-filters-v1';
export const BOARD_COLUMNS_STORAGE_KEY = 'dispatch:board-columns-v1';
export const LIST_COLUMNS_STORAGE_KEY = 'dispatch:list-hidden-columns-v1';

export const EMPTY_TASK_FILTERS: TaskFilters = { statuses: [], priorities: [] };

// Terminal columns start hidden: on a long-lived project they hold the bulk of the tasks
// (this repo: 28 of 109), crowd the open pipeline off-screen, and landed work already has
// the Landing page. The Display menu re-shows them.
export const DEFAULT_BOARD_COLUMN_PREFS: BoardColumnPrefs = {
  hideEmpty: true,
  hidden: ['landed', 'dropped'],
  groupByEpic: false,
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

export function parseTaskFilters(stored: string | null): TaskFilters {
  if (stored === null) return EMPTY_TASK_FILTERS;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) {
      return EMPTY_TASK_FILTERS;
    }
    const record = parsed as Record<string, unknown>;
    return {
      statuses: stringArray(record.statuses),
      priorities: stringArray(record.priorities),
    };
  } catch {
    return EMPTY_TASK_FILTERS;
  }
}

export function parseBoardColumnPrefs(stored: string | null): BoardColumnPrefs {
  if (stored === null) return DEFAULT_BOARD_COLUMN_PREFS;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_BOARD_COLUMN_PREFS;
    }
    const record = parsed as Record<string, unknown>;
    return {
      hideEmpty:
        typeof record.hideEmpty === 'boolean' ? record.hideEmpty : true,
      hidden: stringArray(record.hidden),
      groupByEpic:
        typeof record.groupByEpic === 'boolean' ? record.groupByEpic : false,
    };
  } catch {
    return DEFAULT_BOARD_COLUMN_PREFS;
  }
}

export function parseHiddenListColumns(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    return stringArray(JSON.parse(stored));
  } catch {
    return [];
  }
}

/** Toggles one value in a filter array — the chip row's onToggle. */
export function toggleFilterValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}

export function hasActiveFilters(filters: TaskFilters): boolean {
  return filters.statuses.length > 0 || filters.priorities.length > 0;
}

/** Whether one task passes the chip filters. Empty filter arrays pass everything; active
 * statuses/priorities each union within their group and intersect across groups. */
export function matchesTaskFilters(
  doc: TaskDoc,
  filters: TaskFilters
): boolean {
  if (
    filters.statuses.length > 0 &&
    !filters.statuses.includes(doc.meta.status)
  ) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(doc.meta.priority)
  ) {
    return false;
  }
  return true;
}

/** Which board status columns render, honoring explicit hides first, then the hide-empty
 * rule against the *unfiltered* card counts (a chip filter shouldn't make columns vanish). */
export function visibleBoardStatuses(
  statuses: string[],
  prefs: BoardColumnPrefs,
  countByStatus: ReadonlyMap<string, number>
): string[] {
  const hidden = new Set(prefs.hidden);
  return statuses.filter((status) => {
    if (hidden.has(status)) return false;
    if (prefs.hideEmpty && (countByStatus.get(status) ?? 0) === 0) {
      return false;
    }
    return true;
  });
}
