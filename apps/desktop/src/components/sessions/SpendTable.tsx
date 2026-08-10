import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { EmptyState } from '@/ui/chrome';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';

interface SpendRow {
  key: string;
  label: ReactNode;
  sessionCount: number;
  totalCostUsd: number;
}

interface SpendTableProps {
  /** Header for the row-identity column, e.g. "Project" / "Model". */
  columnLabel: string;
  rows: SpendRow[];
  emptyMessage: string;
  /** When set, each row becomes clickable and calls back with its `key` — the Sessions hub's
   * "spend by project" table uses this to toggle the session list below to that project. Rows
   * render as plain (non-interactive) text when omitted, e.g. the "spend by model" table. */
  onRowClick?: (key: string) => void;
  /** The `key` of the row to render in an active/selected state — set together with
   * `onRowClick` so the currently-filtered project stays visually highlighted. */
  activeKey?: string;
}

/**
 * The "sessions + spend, grouped by X" table the Sessions hub renders for both its "spend by
 * model" and "spend by project" sections — one shared component owns the markup, each caller
 * only supplies its own rows and the label for the grouping column. Optionally clickable (see
 * `onRowClick`) so the same table doubles as the project filter control.
 */
export function SpendTable({
  columnLabel,
  rows,
  emptyMessage,
  onRowClick,
  activeKey,
}: SpendTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        message={emptyMessage}
        className="px-0 py-0 [&_[data-slot=empty-description]]:text-[13px]"
      />
    );
  }

  return (
    <Table className="text-[13px]">
      <TableHeader>
        {/* Table's base row hover (hover:bg-muted/50) doesn't apply to a header row in the
            old design, so it's neutralized here same as the body rows below. */}
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-muted-foreground h-auto px-0 py-2 text-[11px] font-medium tracking-wide whitespace-normal uppercase">
            {columnLabel}
          </TableHead>
          <TableHead className="text-muted-foreground h-auto px-0 py-2 text-right text-[11px] font-medium tracking-wide whitespace-normal uppercase">
            Sessions
          </TableHead>
          <TableHead className="text-muted-foreground h-auto px-0 py-2 text-right text-[11px] font-medium tracking-wide whitespace-normal uppercase">
            Spend
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.key}
            onClick={onRowClick ? () => onRowClick(row.key) : undefined}
            className={cn(
              'hover:bg-transparent',
              onRowClick &&
                'hover:bg-accent/40 cursor-pointer transition-colors',
              activeKey === row.key && 'bg-accent/50'
            )}
          >
            <TableCell className="text-foreground px-0 py-2 whitespace-normal">
              {row.label}
            </TableCell>
            <TableCell className="text-muted-foreground px-0 py-2 text-right font-mono whitespace-normal">
              {row.sessionCount}
            </TableCell>
            <TableCell className="text-muted-foreground px-0 py-2 text-right font-mono whitespace-normal">
              ${row.totalCostUsd.toFixed(2)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
