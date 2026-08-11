import type {
  GateStatus,
  LandingGate,
  LandingGroup,
  LandingRow,
  LandingSnapshot,
  RepoPr,
} from '@dispatch/client';

/**
 * The Landing view's read model over `LandingSnapshot`.
 *
 * Zero React — Pierre's happy-dom test setup can't exercise the table
 * component reliably (no canvas, worker-backed editors), so every rule
 * about what shows, in what order, and under what label lives here where
 * it is directly testable. Task 9's table component renders these outputs
 * without re-deriving any of them.
 */

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

// Mirrors `groupForGate` in packages/server/src/landing.ts. @dispatch/client
// re-exports the landing *types* (the established "mirror, don't import"
// convention for this package — it does not depend on @dispatch/server) but
// not this function, so it is mirrored here rather than duplicated as a
// second server round-trip. Keep in sync with the server copy if the
// bucketing rules change.
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

/**
 * Filters, then groups, `snapshot.rows` into the table's flat render list:
 * a `'group'` header immediately followed by its `'row'` entries, in the
 * fixed section order (needs-you, in-queue, waiting-github, open). A
 * section with zero surviving rows is omitted entirely rather than shown
 * empty. Within a section, rows keep the relative order the snapshot gave
 * them (already queue-position/recency sorted server-side).
 */
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

/**
 * The chip text next to a row's gate.
 *
 * `queueRows`, when given, is the full ordered in-queue row list (position
 * order) — needed only for a position >1 row, whose label names the entry
 * immediately ahead of it. A `LandingRow` on its own carries no reference to
 * that other entry's title, so the caller (which already has every in-queue
 * row on hand to render the section) passes the list rather than this
 * function reaching back into a snapshot. Omitting it, or the ahead row not
 * being found in it, falls back to `gate.detail`.
 */
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

/** Parses the persisted filter state, defaulting to `EMPTY_FILTERS` on
 * anything that isn't a well-formed `LandingFilters` (missing key,
 * unrecognized `gate`, malformed JSON, or no stored value at all). */
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

/** Short relative-time readout for an ISO timestamp, as of `now` (injected
 * rather than read from `Date.now()` so this stays pure and testable):
 * 'Nm ago' under an hour, 'Nh ago' under a day, 'Nd ago' under a week, and a
 * locale date string beyond that. */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const diffMs = Math.max(0, now - then);
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  if (diffMs < WEEK_MS) return `${Math.floor(diffMs / DAY_MS)}d ago`;
  return new Date(then).toLocaleDateString();
}
