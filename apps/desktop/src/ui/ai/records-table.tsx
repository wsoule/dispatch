import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  type LucideIcon,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';

import { formatRelativeTimeFromIso } from '@/lib/format';

export type RecordsCellKind = 'text' | 'tags' | 'time' | 'strength';

export type RecordsColumn = {
  key: string;
  label: string;
  kind?: RecordsCellKind;
};

export type RecordsRow = {
  id: string;
  cells: Record<string, unknown>;
};

export type RecordsSort = { key: string; dir: 'asc' | 'desc' } | null;

export type RecordsTableProps = {
  columns: RecordsColumn[];
  rows: RecordsRow[];
  sort: RecordsSort;
  onSortChange?: (sort: RecordsSort) => void;
  onRowClick?: (row: RecordsRow) => void;
};

// Coerces a time-cell value (ISO string, epoch ms, or Date) to epoch ms for chronological
// comparison. Unparseable input sorts as 0 rather than throwing or producing NaN comparisons.
function toTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Stringifies a scalar cell value for label comparisons/plain-text display. Anything that
// isn't a string/number/boolean (an object, say) becomes '' rather than risking `String()`'s
// "[object Object]" default stringification.
function toLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

// Compares two cell values for a given column kind: numeric for `strength`, chronological
// for `time`, joined-label for `tags`, and number-or-string for plain `text`/undefined.
function compareValues(
  a: unknown,
  b: unknown,
  kind: RecordsCellKind | undefined
): number {
  if (kind === 'time') return toTimestamp(a) - toTimestamp(b);
  if (kind === 'strength') return toNumber(a) - toNumber(b);
  if (kind === 'tags') {
    const aLabel = Array.isArray(a) ? a.join(', ') : toLabel(a);
    const bLabel = Array.isArray(b) ? b.join(', ') : toLabel(b);
    return aLabel.localeCompare(bLabel);
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return toLabel(a).localeCompare(toLabel(b));
}

/** Sorts `rows` by the column named in `sort.key`, using that column's `kind` to pick a
 * string/number/date-aware comparator. Returns a new array; when `sort` is null, returns
 * the rows in their original order unchanged. Uses a decorate-sort-undecorate so rows tied
 * on the sort key keep their original relative order (stable), independent of the runtime's
 * own `Array.prototype.sort` stability guarantees. */
export function sortRows(
  rows: RecordsRow[],
  columns: RecordsColumn[],
  sort: RecordsSort
): RecordsRow[] {
  if (!sort) return [...rows];
  const column = columns.find((candidate) => candidate.key === sort.key);
  const direction = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const cmp = compareValues(
        a.row.cells[sort.key],
        b.row.cells[sort.key],
        column?.kind
      );
      return cmp !== 0 ? cmp * direction : a.index - b.index;
    })
    .map(({ row }) => row);
}

const STRENGTH_BAR_HEIGHTS = ['h-1.5', 'h-2.5', 'h-3.5'];

// Three-bar signal-style meter: bars up to `level` (clamped 0-3) filled with the accent
// colour, the rest muted. A single `aria-label` on the wrapper carries the value for
// assistive tech since the bars themselves are decorative.
function RecordsStrengthCell({ value }: { value: unknown }) {
  const level = Math.max(0, Math.min(3, toNumber(value)));
  return (
    <span
      aria-label={`Strength ${level} of 3`}
      className="inline-flex items-end gap-0.5"
    >
      {STRENGTH_BAR_HEIGHTS.map((height, index) => (
        <span
          key={height}
          aria-hidden
          className={`w-1 rounded-[1px] ${height} ${
            index < level ? 'bg-primary' : 'bg-surface-inset'
          }`}
        />
      ))}
    </span>
  );
}

function RecordsTagsCell({ value }: { value: unknown }) {
  const tags = Array.isArray(value) ? value.map(String) : [];
  if (tags.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-chip bg-surface-inset text-foreground inline-flex h-5 shrink-0 items-center px-2 text-[11px] font-medium"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function RecordsTimeCell({ value }: { value: unknown }) {
  const label =
    typeof value === 'string' ? formatRelativeTimeFromIso(value) : '—';
  return (
    <span className="text-muted-foreground font-mono text-[11.5px] tabular-nums">
      {label}
    </span>
  );
}

function RecordsCell({
  value,
  kind,
}: {
  value: unknown;
  kind?: RecordsCellKind;
}) {
  if (kind === 'tags') return <RecordsTagsCell value={value} />;
  if (kind === 'time') return <RecordsTimeCell value={value} />;
  if (kind === 'strength') return <RecordsStrengthCell value={value} />;
  return (
    <span className="text-foreground truncate">
      {value === null || value === undefined ? '—' : toLabel(value)}
    </span>
  );
}

// Cycles a column's sort state: unsorted -> asc -> desc -> unsorted. Matches the showcase's
// header-button affordance, where clicking the same header again eventually clears the sort.
function nextSort(column: RecordsColumn, current: RecordsSort): RecordsSort {
  if (current?.key !== column.key) return { key: column.key, dir: 'asc' };
  if (current.dir === 'asc') return { key: column.key, dir: 'desc' };
  return null;
}

const SORT_ICON: Record<'asc' | 'desc' | 'none', LucideIcon> = {
  asc: ChevronUp,
  desc: ChevronDown,
  none: ChevronsUpDown,
};

function RecordsHeaderCell({
  column,
  sort,
  onSortChange,
}: {
  column: RecordsColumn;
  sort: RecordsSort;
  onSortChange?: (sort: RecordsSort) => void;
}) {
  const isActive = sort?.key === column.key;
  const direction = isActive ? sort.dir : 'none';
  const Icon = SORT_ICON[direction];

  return (
    <th
      scope="col"
      className="bg-surface-inset text-muted-foreground shadow-hairline-bottom sticky top-0 z-10 px-3 py-2.5 text-left text-[11.5px] font-semibold"
    >
      {onSortChange ? (
        <button
          type="button"
          onClick={() => onSortChange(nextSort(column, sort))}
          aria-label={`Sort by ${column.label}`}
          className="group/sort hover:text-foreground inline-flex items-center gap-1"
        >
          <span className="truncate">{column.label}</span>
          <Icon
            aria-hidden
            className={`size-3 shrink-0 transition-opacity duration-100 ${
              isActive ? 'opacity-100' : 'opacity-0 group-hover/sort:opacity-60'
            }`}
          />
        </button>
      ) : (
        <span className="truncate">{column.label}</span>
      )}
    </th>
  );
}

function RecordsBodyRow({
  row,
  columns,
  onRowClick,
}: {
  row: RecordsRow;
  columns: RecordsColumn[];
  onRowClick?: (row: RecordsRow) => void;
}) {
  const interactive = onRowClick !== undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
    if (!onRowClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick(row);
    }
  }

  return (
    <tr
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onRowClick(row) : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={`ease-out-expo shadow-hairline-bottom transition-colors duration-100 ${
        interactive ? 'hover:bg-surface-hover cursor-pointer' : ''
      }`}
    >
      {columns.map((column) => (
        <td key={column.key} className="px-3 py-2.5 align-middle">
          <RecordsCell value={row.cells[column.key]} kind={column.kind} />
        </td>
      ))}
    </tr>
  );
}

/** Full-bleed data grid: a sticky, muted header row with sort chevrons (`onSortChange`
 * cycles unsorted -> asc -> desc -> unsorted per column) over hairline-divided rows that
 * wash `bg-surface-hover` on hover when `onRowClick` is given. Cells render per their
 * column's `kind` — `tags` as a chip row, `time` as a relative, monospaced timestamp,
 * `strength` as a 3-bar meter, everything else as plain text. Matches the showcase's
 * "Records Table" primitive, adapted from its CRM-specific chrome (checkboxes, links,
 * calculation footer) to the generic columns/rows contract Task 26 renders
 * `TasksListView` through. */
export function RecordsTable({
  columns,
  rows,
  sort,
  onSortChange,
  onRowClick,
}: RecordsTableProps) {
  return (
    <div className="rounded-card border-border bg-card shadow-card overflow-hidden border">
      <div className="max-h-full overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {columns.map((column) => (
                <RecordsHeaderCell
                  key={column.key}
                  column={column}
                  sort={sort}
                  onSortChange={onSortChange}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RecordsBodyRow
                key={row.id}
                row={row}
                columns={columns}
                onRowClick={onRowClick}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
