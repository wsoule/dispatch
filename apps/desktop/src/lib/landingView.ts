import type {
  GateStatus,
  LandingGate,
  LandingGroup,
  LandingRow,
  LandingSnapshot,
  RepoPr,
} from '@dispatch/client';

/** The Landing view's read model over `LandingSnapshot`. Zero React — happy-dom
 * can't exercise the table reliably, so filter/group/label logic lives here. */

export interface LandingFilters {
  /** Free-text query: matches title, PR author, head branch, or '#<number>'. */
  query: string;
  /** Author facet chip — exact match against the row's PR author. */
  author: string | null;
  /** Gate-status facet chip — exact match against the row's gate. */
  gate: GateStatus | null;
}

export const EMPTY_FILTERS: LandingFilters = {
  query: '',
  author: null,
  gate: null,
};

export type LandingViewRow =
  | { type: 'group'; id: LandingGroup; label: string; count: number }
  | { type: 'row'; row: LandingRow };

export const GROUP_LABELS: Record<LandingGroup, string> = {
  'needs-you': 'Needs you',
  'in-queue': 'In queue',
  'waiting-github': 'Waiting on GitHub',
  open: 'Open',
};

// Fixed section order the table always renders in, regardless of row order
// in the snapshot.
const GROUP_ORDER: readonly LandingGroup[] = [
  'needs-you',
  'in-queue',
  'waiting-github',
  'open',
];

// Mirrors `groupForGate` in packages/server/src/landing.ts — @dispatch/client
// re-exports the landing types but not this function. Keep both in sync.
function groupForGate(gate: LandingGate, pr?: RepoPr): LandingGroup {
  switch (gate.status) {
    case 'conflicts':
      return 'needs-you';
    case 'waiting-checks':
      return pr !== undefined && pr.checks.failed > 0
        ? 'needs-you'
        : 'waiting-github';
    case 'waiting-review':
      return pr?.reviewDecision === 'CHANGES_REQUESTED'
        ? 'needs-you'
        : 'waiting-github';
    case 'queue-position':
    case 'verifying':
    case 'merging':
    case 'blocked':
      return 'in-queue';
    case 'draft':
      return 'waiting-github';
    case 'ready':
    case 'none':
    default:
      return 'open';
  }
}

// True when `row` matches the free-text query against title, PR author,
// head branch, or a '#<number>' PR-number lookup (the '#' is optional).
function matchesQuery(row: LandingRow, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q === '') return true;

  const numberQuery = q.startsWith('#') ? q.slice(1) : q;
  if (
    row.pr !== undefined &&
    /^\d+$/.test(numberQuery) &&
    String(row.pr.number) === numberQuery
  ) {
    return true;
  }

  if (row.title.toLowerCase().includes(q)) return true;
  if (row.pr !== undefined && row.pr.author.toLowerCase().includes(q)) {
    return true;
  }
  if (row.pr !== undefined && row.pr.headRefName.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

function matchesFilters(row: LandingRow, filters: LandingFilters): boolean {
  if (!matchesQuery(row, filters.query)) return false;
  if (filters.author !== null && row.pr?.author !== filters.author) {
    return false;
  }
  if (filters.gate !== null && row.gate.status !== filters.gate) return false;
  return true;
}

/** Filters `snapshot.rows`, then groups them into the table's flat render list
 * (group header + its rows, fixed section order, empty sections omitted). */
export function visibleLandingRows(
  snapshot: LandingSnapshot,
  filters: LandingFilters
): LandingViewRow[] {
  const buckets: Record<LandingGroup, LandingRow[]> = {
    'needs-you': [],
    'in-queue': [],
    'waiting-github': [],
    open: [],
  };

  for (const row of snapshot.rows) {
    if (!matchesFilters(row, filters)) continue;
    buckets[groupForGate(row.gate, row.pr)].push(row);
  }

  const result: LandingViewRow[] = [];
  for (const group of GROUP_ORDER) {
    const rows = buckets[group];
    if (rows.length === 0) continue;
    result.push({
      type: 'group',
      id: group,
      label: GROUP_LABELS[group],
      count: rows.length,
    });
    for (const row of rows) result.push({ type: 'row', row });
  }
  return result;
}

/** The chip text next to a row's gate. `queueRows`, the ordered in-queue row
 * list, names the entry ahead for a position >1 row; falls back to `gate.detail`. */
export function gateChipLabel(
  row: LandingRow,
  queueRows: readonly LandingRow[] = []
): string {
  const { gate } = row;

  switch (gate.status) {
    case 'conflicts':
      return 'Conflicts';
    case 'draft':
      return 'Draft';
    case 'verifying': {
      const steps = row.queue?.entry.steps;
      if (steps === undefined || steps.length === 0) return gate.detail;
      const passed = steps.filter((s) => s.status === 'passed').length;
      return `Verifying · ${passed}/${steps.length}`;
    }
    case 'queue-position': {
      const position = row.queue?.position;
      if (position === undefined) return gate.detail;
      if (position === 1) return 'Ready · next';
      const ahead = queueRows.find((r) => r.queue?.position === position - 1);
      if (ahead === undefined) return gate.detail;
      return `#${position} · behind ${ahead.title}`;
    }
    case 'waiting-checks': {
      const pending = row.pr?.checks.pending ?? 0;
      if (pending > 0) return `Waiting on CI · ${pending} running`;
      return gate.detail;
    }
    default:
      return gate.detail;
  }
}

/** Count of needs-you rows — the sidebar's Landing badge. */
export function landingNavBadge(snapshot: LandingSnapshot): number {
  return snapshot.rows.filter(
    (row) => groupForGate(row.gate, row.pr) === 'needs-you'
  ).length;
}

const GATE_STATUSES: readonly GateStatus[] = [
  'ready',
  'waiting-checks',
  'waiting-review',
  'conflicts',
  'draft',
  'queue-position',
  'verifying',
  'merging',
  'blocked',
  'none',
];

function isGateStatus(value: unknown): value is GateStatus {
  return (
    typeof value === 'string' &&
    (GATE_STATUSES as readonly string[]).includes(value)
  );
}

/** Parses the persisted filter state, defaulting to `EMPTY_FILTERS` on anything
 * that isn't well-formed (missing key, bad `gate`, malformed JSON, or `null`). */
export function readLandingFilters(raw: string | null): LandingFilters {
  if (raw === null) return EMPTY_FILTERS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_FILTERS;
  }

  if (typeof parsed !== 'object' || parsed === null) return EMPTY_FILTERS;
  const obj = parsed as Record<string, unknown>;

  const query = typeof obj.query === 'string' ? obj.query : '';
  const author = typeof obj.author === 'string' ? obj.author : null;
  const gate = isGateStatus(obj.gate) ? obj.gate : null;
  return { query, author, gate };
}

export function serializeLandingFilters(filters: LandingFilters): string {
  return JSON.stringify(filters);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Relative-time readout for an ISO timestamp as of `now` (injected, not
 * `Date.now()`): 'Nm/Nh/Nd ago' under a week, else a locale date string. */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const diffMs = Math.max(0, now - then);
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  if (diffMs < WEEK_MS) return `${Math.floor(diffMs / DAY_MS)}d ago`;
  return new Date(then).toLocaleDateString();
}
