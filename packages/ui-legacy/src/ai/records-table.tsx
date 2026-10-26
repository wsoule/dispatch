import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import { cn } from '../lib/utils';
import { GroupHeader } from './group-header';
import { colorForLabel, formatShortDate } from './list-format';
import { ListRow } from './list-row';
import { LabelPill } from './pill';

type RecordsCellKind = 'text' | 'tags' | 'time' | 'strength';

/** Where a column's cell lands on the `ListRow`: the first column defaults to `title`,
 * a `time` column to `date`, everything else to the right-aligned `trailing` group. */
export type RecordsSlot =
  | 'leading'
  | 'id'
  | 'status'
  | 'title'
  | 'trailing'
  | 'date';

export type RecordsColumn = {
  key: string;
  label: string;
  kind?: RecordsCellKind;
  slot?: RecordsSlot;
};

export type RecordsRow = {
  id: string;
  cells: Record<string, unknown>;
};

export type RecordsSort = { key: string; dir: 'asc' | 'desc' } | null;

/** One section of rows under a `GroupHeader` — `name` null renders the rows with no bar. */
export type RecordsGroup = {
  key: string;
  name: ReactNode | null;
  /** The header's 14px glyph and its left-edge tint. */
  icon?: ReactNode;
  tint?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  onAdd?: () => void;
  rows: RecordsRow[];
};

export type RecordsTableProps = {
  columns: RecordsColumn[];
  /** Flat row list. Mutually exclusive with `groups` (pass exactly one). */
  rows?: RecordsRow[];
  /** Grouped row sections — see `RecordsGroup`. Each group's own row order is preserved. */
  groups?: RecordsGroup[];
  sort: RecordsSort;
  onSortChange?: (sort: RecordsSort) => void;
  /** A column-label row above the rows, with sort chevrons when `onSortChange` is given.
   * Off by default: Linear's list has no header row. */
  showHeader?: boolean;
  onRowClick?: (row: RecordsRow) => void;
  onRowMouseEnter?: (rowId: string) => void;
  /** Rows grow a hover-revealed checkbox at the far left. */
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (rowId: string) => void;
  /** The checkbox's accessible name for a given row — defaults to the row id. */
  selectLabel?: (row: RecordsRow) => string;
  /** The keyboard cursor's row, rendered with the neutral focus wash. */
  focusedId?: string | null;
  /** Escape hatch for a cell that isn't one of the four generic `kind`s. Return `undefined`
   * to fall back to the kind-based rendering; `null` to render nothing. */
  renderCell?: (
    row: RecordsRow,
    column: RecordsColumn
  ) => ReactNode | undefined;
  /** Extra class names for one row, composed alongside its own. */
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

/** A time cell's absolute label — `Sep 13`, with the year once it is not the current one —
 * or `null` for an empty/unparseable value so the slot renders nothing. Exported for the
 * test that pins the row's date treatment. */
export function formatRecordsDate(
  value: unknown,
  now: Date = new Date()
): string | null {
  const ms = toTimestamp(value);
  return ms === 0 ? null : formatShortDate(ms, now);
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
            index < level ? 'bg-accent' : 'bg-[var(--border-chip)]'
          }`}
        />
      ))}
    </span>
  );
}

// Tags are label pills with the 8px dot; no tags renders nothing at all.
function RecordsTagsCell({ value }: { value: unknown }) {
  const tags = Array.isArray(value) ? value.map(String) : [];
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <LabelPill key={tag} color={colorForLabel(tag)}>
          {tag}
        </LabelPill>
      ))}
    </>
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
  if (kind === 'time') return <>{formatRecordsDate(value)}</>;
  if (kind === 'strength') return <RecordsStrengthCell value={value} />;
  if (value === null || value === undefined) return null;
  return <>{toLabel(value)}</>;
}

// Cycles a column's sort state: unsorted -> asc -> desc -> unsorted.
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
  className,
}: {
  column: RecordsColumn;
  sort: RecordsSort;
  onSortChange?: (sort: RecordsSort) => void;
  className?: string;
}) {
  const isActive = sort?.key === column.key;
  const direction = isActive ? sort.dir : 'none';
  const Icon = SORT_ICON[direction];

  return (
    <span
      role="columnheader"
      data-slot="records-header-cell"
      className={cn('min-w-0 truncate', className)}
    >
      {onSortChange ? (
        <button
          type="button"
          onClick={() => onSortChange(nextSort(column, sort))}
          aria-label={`Sort by ${column.label}`}
          className="group/sort inline-flex items-center gap-1 hover:text-(--text-secondary)"
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
    </span>
  );
}

function slotOf(column: RecordsColumn, index: number): RecordsSlot {
  if (column.slot !== undefined) return column.slot;
  if (index === 0) return 'title';
  if (column.kind === 'time') return 'date';
  return 'trailing';
}

// Normalizes the `rows`/`groups` split into one shape the render below always walks: a flat
// `rows` list becomes a single headerless group.
function toSections(
  rows: RecordsRow[] | undefined,
  groups: RecordsGroup[] | undefined
): RecordsGroup[] {
  if (groups !== undefined) return groups;
  return [{ key: '__flat__', name: null, rows: rows ?? [] }];
}

/** A Linear-style records list: `ListRow`s (36px, no card, no dividers, a hover checkbox
 * when `selectable`) under optional `GroupHeader`s, with cells placed by column slot — the
 * first column is the title, a `time` column the far-right `Sep 13` date, and everything
 * else joins the right-aligned trailing group (tags as `LabelPill`s, strength as a meter).
 * `showHeader` adds a label row with sort chevrons (`onSortChange` cycles
 * unsorted -> asc -> desc); `sortRows` is the matching comparator. */
export function RecordsTable({
  columns,
  rows,
  groups,
  sort,
  onSortChange,
  showHeader = false,
  onRowClick,
  onRowMouseEnter,
  selectable = false,
  selectedIds,
  onToggleSelect,
  selectLabel,
  focusedId,
  renderCell,
  rowClassName,
}: RecordsTableProps) {
  const sections = toSections(rows, groups);
  const placed = columns.map((column, index) => ({
    column,
    slot: slotOf(column, index),
  }));
  const titleColumns = placed.filter((p) => p.slot === 'title');
  const rightColumns = placed.filter(
    (p) => p.slot === 'trailing' || p.slot === 'date'
  );
  const leftColumns = placed.filter(
    (p) => p.slot === 'leading' || p.slot === 'id' || p.slot === 'status'
  );

  const cell = (row: RecordsRow, column: RecordsColumn): ReactNode => {
    const custom = renderCell?.(row, column);
    if (custom !== undefined) return custom;
    return <RecordsCell value={row.cells[column.key]} kind={column.kind} />;
  };

  const slotContent = (row: RecordsRow, slot: RecordsSlot): ReactNode => {
    const matches = placed.filter((p) => p.slot === slot);
    if (matches.length === 0) return undefined;
    if (matches.length === 1 && matches[0] !== undefined) {
      return cell(row, matches[0].column);
    }
    return matches.map((p) => (
      <Fragment key={p.column.key}>{cell(row, p.column)}</Fragment>
    ));
  };

  return (
    <div
      role="table"
      data-slot="records-table"
      className="flex flex-col text-[13px]"
    >
      {showHeader && (
        <div
          role="row"
          data-slot="records-header"
          className="text-muted-foreground flex h-9 items-center gap-2 px-3 text-[12px] font-medium"
        >
          {selectable && <span aria-hidden className="size-4 shrink-0" />}
          {leftColumns.map((p) => (
            <RecordsHeaderCell
              key={p.column.key}
              column={p.column}
              sort={sort}
              onSortChange={onSortChange}
              className="shrink-0"
            />
          ))}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {titleColumns.map((p) => (
              <RecordsHeaderCell
                key={p.column.key}
                column={p.column}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
          </span>
          {rightColumns.map((p) => (
            <RecordsHeaderCell
              key={p.column.key}
              column={p.column}
              sort={sort}
              onSortChange={onSortChange}
              className="shrink-0"
            />
          ))}
        </div>
      )}
      {sections.map((section) => (
        <Fragment key={section.key}>
          {section.name !== null && (
            <GroupHeader
              name={section.name}
              icon={section.icon}
              tint={section.tint}
              count={section.rows.length}
              collapsed={section.collapsed}
              onToggle={section.onToggle}
              onAdd={section.onAdd}
            />
          )}
          {!section.collapsed &&
            section.rows.map((row) => (
              <ListRow
                key={row.id}
                data-row-id={row.id}
                leading={slotContent(row, 'leading')}
                id={slotContent(row, 'id')}
                status={slotContent(row, 'status')}
                title={slotContent(row, 'title') ?? null}
                trailing={slotContent(row, 'trailing')}
                date={slotContent(row, 'date')}
                selected={selectedIds?.has(row.id) ?? false}
                focused={focusedId === row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onMouseEnter={
                  onRowMouseEnter ? () => onRowMouseEnter(row.id) : undefined
                }
                onSelectToggle={
                  selectable ? () => onToggleSelect?.(row.id) : undefined
                }
                selectLabel={selectLabel?.(row) ?? `Select ${row.id}`}
                className={rowClassName?.(row)}
              />
            ))}
        </Fragment>
      ))}
    </div>
  );
}
