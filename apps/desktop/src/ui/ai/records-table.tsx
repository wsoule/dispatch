import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, type KeyboardEvent, type ReactNode } from 'react';

import { formatRelativeTimeFromIso } from '@/lib/format';
import { Checkbox } from '@/ui/checkbox';

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

/** One collapsible/labelled section of rows, for a table whose rows aren't a flat list —
 * `TasksListView`'s per-epic grouping is the motivating case. Rendered as a full-width row
 * (spanning every column) ahead of that section's own rows, inside the *same* table as every
 * other group — one sticky column header for the whole table, not one per group. */
export type RecordsGroup = {
  key: string;
  /** Arbitrary content for the section's header row — an expand/collapse trigger, counts, a
   * secondary action button, whatever the caller needs. `null` renders no header row at all
   * (a headerless catch-all section). The table has no opinion on what a "group" means; it
   * only lays the header out and puts that group's rows underneath it. */
  header: ReactNode;
  rows: RecordsRow[];
};

export type RecordsTableProps = {
  columns: RecordsColumn[];
  /** Flat row list. Mutually exclusive with `groups` (pass exactly one). */
  rows?: RecordsRow[];
  /** Grouped row sections — see `RecordsGroup`. Mutually exclusive with `rows`. Each group's
   * own row order is preserved (sort still applies within a group if the caller pre-sorts
   * each group's `rows` — the table itself never reorders what it's given). */
  groups?: RecordsGroup[];
  sort: RecordsSort;
  onSortChange?: (sort: RecordsSort) => void;
  onRowClick?: (row: RecordsRow) => void;
  /** Called when the pointer enters a row — for callers that sync a keyboard roving-focus
   * cursor to whatever the mouse is over (`TasksListView`'s j/k navigation), matching the
   * pre-reskin row's own `onMouseEnter`. Purely a pass-through; the table has no roving-focus
   * concept of its own. */
  onRowMouseEnter?: (rowId: string) => void;
  /** Adds a leading checkbox column — a bulk-selection affordance the generic `kind` cells
   * can't express on their own. */
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  /** Called with a row's id when its checkbox is toggled. Required for `selectable` to do
   * anything; the checkbox itself always reflects `selectedIds` (controlled, not local state). */
  onToggleSelect?: (rowId: string) => void;
  /** The checkbox's accessible name for a given row — defaults to the row id. */
  selectLabel?: (row: RecordsRow) => string;
  /** Escape hatch for a cell that isn't one of the four generic `kind`s — an inline picker, a
   * badge, a composite of several fields (Linear's `t-id › Epic title` breadcrumb, say).
   * Return `undefined` to fall back to the default kind-based rendering for that (row, column)
   * pair; return `null` to render nothing. Keeps the table itself agnostic of what any of
   * those richer cells actually are. */
  renderCell?: (
    row: RecordsRow,
    column: RecordsColumn
  ) => ReactNode | undefined;
  /** Extra class names for one row's `<tr>` — e.g. a keyboard roving-focus highlight, an
   * archived/dimmed treatment, or an attention wash. Composed alongside the row's own base
   * classes, never replacing them. */
  rowClassName?: (row: RecordsRow) => string | undefined;
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
  onRowMouseEnter,
  selectable = false,
  selected = false,
  onToggleSelect,
  selectLabel,
  renderCell,
  className,
}: {
  row: RecordsRow;
  columns: RecordsColumn[];
  onRowClick?: (row: RecordsRow) => void;
  onRowMouseEnter?: (rowId: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (rowId: string) => void;
  selectLabel?: (row: RecordsRow) => string;
  renderCell?: (
    row: RecordsRow,
    column: RecordsColumn
  ) => ReactNode | undefined;
  className?: string;
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
      data-row-id={row.id}
      onClick={interactive ? () => onRowClick(row) : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      onMouseEnter={onRowMouseEnter ? () => onRowMouseEnter(row.id) : undefined}
      className={`ease-out-expo shadow-hairline-bottom transition-colors duration-100 ${
        interactive ? 'hover:bg-surface-hover cursor-pointer' : ''
      } ${className ?? ''}`}
    >
      {selectable && (
        <td className="px-2 py-2.5 align-middle">
          {/* Selecting a row and opening it are different intents, so the checkbox itself
              (a real, keyboard-operable control — unlike the plain `<td>` around it) stops
              its click from bubbling to the row's own `onClick` above. */}
          <Checkbox
            checked={selected}
            aria-label={selectLabel?.(row) ?? `Select ${row.id}`}
            onClick={(event) => event.stopPropagation()}
            onCheckedChange={() => onToggleSelect?.(row.id)}
          />
        </td>
      )}
      {columns.map((column) => (
        <td key={column.key} className="px-3 py-2.5 align-middle">
          {renderCell?.(row, column) ?? (
            <RecordsCell value={row.cells[column.key]} kind={column.kind} />
          )}
        </td>
      ))}
    </tr>
  );
}

// Normalizes the `rows`/`groups` split into one shape the render below always walks: a flat
// `rows` list becomes a single headerless group, so there's exactly one rendering path rather
// than a duplicated flat-vs-grouped branch.
function toSections(
  rows: RecordsRow[] | undefined,
  groups: RecordsGroup[] | undefined
): RecordsGroup[] {
  if (groups !== undefined) return groups;
  return [{ key: '__flat__', header: null, rows: rows ?? [] }];
}

/** Full-bleed data grid: a sticky, muted header row with sort chevrons (`onSortChange`
 * cycles unsorted -> asc -> desc -> unsorted per column) over hairline-divided rows that
 * wash `bg-surface-hover` on hover when `onRowClick` is given. Cells render per their
 * column's `kind` — `tags` as a chip row, `time` as a relative, monospaced timestamp,
 * `strength` as a 3-bar meter, everything else as plain text (or `renderCell`'s custom
 * content, when given). Matches the showcase's "Records Table" primitive, adapted from its
 * CRM-specific chrome to the generic columns/rows contract `TasksListView` renders through —
 * `selectable`/`groups`/`renderCell`/`rowClassName` are presentational extensions Task 26
 * added on top of that base contract so a bulk-select column, per-epic grouping, inline
 * pickers, and a keyboard roving-focus highlight could all render through this one table
 * rather than needing a second, bespoke row renderer next to it. */
export function RecordsTable({
  columns,
  rows,
  groups,
  sort,
  onSortChange,
  onRowClick,
  onRowMouseEnter,
  selectable = false,
  selectedIds,
  onToggleSelect,
  selectLabel,
  renderCell,
  rowClassName,
}: RecordsTableProps) {
  const sections = toSections(rows, groups);
  const colSpan = columns.length + (selectable ? 1 : 0);

  return (
    <div className="rounded-card border-border bg-card shadow-card overflow-hidden border">
      <div className="max-h-full overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {selectable && (
                <th
                  scope="col"
                  className="bg-surface-inset shadow-hairline-bottom sticky top-0 z-10 w-8 px-2 py-2.5"
                />
              )}
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
            {sections.map((section) => (
              <Fragment key={section.key}>
                {section.header !== null && (
                  <tr>
                    {/* `top-9` approximates the sticky column header's own height, so a
                        group header sticks directly beneath it rather than under it. */}
                    <td
                      colSpan={colSpan}
                      className="bg-background sticky top-9 z-[5] p-0"
                    >
                      {section.header}
                    </td>
                  </tr>
                )}
                {section.rows.map((row) => (
                  <RecordsBodyRow
                    key={row.id}
                    row={row}
                    columns={columns}
                    onRowClick={onRowClick}
                    onRowMouseEnter={onRowMouseEnter}
                    selectable={selectable}
                    selected={selectedIds?.has(row.id) ?? false}
                    onToggleSelect={onToggleSelect}
                    selectLabel={selectLabel}
                    renderCell={renderCell}
                    className={rowClassName?.(row)}
                  />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
