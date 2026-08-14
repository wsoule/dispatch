import { CheckIcon, XIcon } from 'lucide-react';

import { Button } from '@/ui/button';

type DiffTableColumn = {
  key: string;
  label: string;
};

type DiffCellValue = {
  old?: string;
  next?: string;
};

type DiffTableRowKind = 'add' | 'remove' | 'change';

export type DiffTableRow = {
  id: string;
  kind: DiffTableRowKind;
  cells: Record<string, DiffCellValue>;
};

export type DiffSummary = {
  adds: number;
  removes: number;
  changes: number;
};

// Pure tally of a diff's row kinds — the header chips and any external "N changes"
// caller UI read from this instead of re-deriving counts from the row list.
export function summarizeDiff(rows: DiffTableRow[]): DiffSummary {
  const summary: DiffSummary = { adds: 0, removes: 0, changes: 0 };
  for (const row of rows) {
    if (row.kind === 'add') summary.adds += 1;
    else if (row.kind === 'remove') summary.removes += 1;
    else summary.changes += 1;
  }
  return summary;
}

export type DiffTableProps = {
  columns: DiffTableColumn[];
  rows: DiffTableRow[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
};

const ROW_TINT: Record<DiffTableRowKind, string> = {
  add: 'bg-[var(--green-bg)]',
  remove: 'bg-[var(--red-bg)]',
  change: '',
};

// Row-kind-aware chip: a colored dot plus a count, hidden entirely when its count is
// zero so a diff with no removals doesn't leave an empty "0 removed" chip in the header.
function SummaryChip({
  count,
  label,
  dotClassName,
  textClassName,
}: {
  count: number;
  label: string;
  dotClassName: string;
  textClassName: string;
}) {
  if (count === 0) return null;
  return (
    <span className="rounded-chip bg-surface-inset shadow-hairline inline-flex h-6 items-center gap-1.5 px-2 text-[11.5px] font-medium">
      <span aria-hidden className={`size-1.5 rounded-full ${dotClassName}`} />
      <span className={textClassName}>
        {count} {label}
      </span>
    </span>
  );
}

// Renders one data cell for a diff row. `add`/`remove` rows only ever carry one side
// of the value (the row-level tint + strikethrough already communicate the kind), so
// those just print what's there. `change` rows show `old → next` when both sides
// differ, and fall back to whichever side is present for cells the edit didn't touch.
function DiffCell({
  cell,
  kind,
}: {
  cell: DiffCellValue | undefined;
  kind: DiffTableRowKind;
}) {
  if (cell === undefined) return null;

  if (kind === 'remove') return <>{cell.old}</>;
  if (kind === 'add') return <>{cell.next}</>;

  if (
    cell.old !== undefined &&
    cell.next !== undefined &&
    cell.old !== cell.next
  ) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground truncate line-through">
          {cell.old}
        </span>
        <span aria-hidden className="text-muted-foreground shrink-0">
          →
        </span>
        <span className="text-primary truncate font-medium">{cell.next}</span>
      </span>
    );
  }

  return <>{cell.next ?? cell.old}</>;
}

/** Table of AI-proposed row-level edits: add rows wash green, remove rows wash red
 * and strike through, change rows show each edited cell as `old → next` (muted
 * strikethrough into accent). A header bar totals the diff via `summarizeDiff` into
 * dismissible-when-zero chips and offers an `Accept all` action; each row reveals
 * per-row accept/reject icon buttons on hover. Matches the showcase's "Diff Table"
 * primitive. */
export function DiffTable({
  columns,
  rows,
  onAccept,
  onReject,
  onAcceptAll,
}: DiffTableProps) {
  const summary = summarizeDiff(rows);

  return (
    <div className="bg-card rounded-card shadow-card w-full overflow-hidden">
      <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <SummaryChip
            count={summary.adds}
            label="added"
            dotClassName="bg-green"
            textClassName="text-green"
          />
          <SummaryChip
            count={summary.removes}
            label="removed"
            dotClassName="bg-red"
            textClassName="text-red"
          />
          <SummaryChip
            count={summary.changes}
            label="changed"
            dotClassName="bg-primary"
            textClassName="text-primary"
          />
        </div>
        <Button size="sm" onClick={onAcceptAll}>
          Accept all
        </Button>
      </div>

      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="border-border border-b">
            {columns.map((column) => (
              <th
                key={column.key}
                className="text-muted-foreground px-3 py-2 text-[12px] font-medium"
              >
                {column.label}
              </th>
            ))}
            <th className="w-16 px-3 py-2" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`group/row border-border ease-out-expo border-t transition-colors duration-100 first:border-t-0 ${ROW_TINT[row.kind]}`}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`min-w-0 truncate px-3 py-2 text-[13px] ${
                    row.kind === 'remove'
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground'
                  }`}
                >
                  <DiffCell cell={row.cells[column.key]} kind={row.kind} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <div className="ease-out-expo flex items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                  <button
                    type="button"
                    aria-label="Accept change"
                    onClick={() => onAccept(row.id)}
                    className="ease-out-expo hover:text-green rounded-control text-muted-foreground flex size-6 items-center justify-center transition-colors duration-100 hover:bg-[var(--green-bg)]"
                  >
                    <CheckIcon aria-hidden className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Reject change"
                    onClick={() => onReject(row.id)}
                    className="ease-out-expo hover:text-red rounded-control text-muted-foreground flex size-6 items-center justify-center transition-colors duration-100 hover:bg-[var(--red-bg)]"
                  >
                    <XIcon aria-hidden className="size-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
