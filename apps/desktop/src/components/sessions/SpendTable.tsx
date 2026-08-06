import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

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
    return <p className="text-muted-foreground text-[13px]">{emptyMessage}</p>;
  }

  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr>
          <th className="border-border text-muted-foreground border-b pb-2 text-left text-[11px] font-medium tracking-wide uppercase">
            {columnLabel}
          </th>
          <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
            Sessions
          </th>
          <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
            Spend
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            onClick={onRowClick ? () => onRowClick(row.key) : undefined}
            className={cn(
              onRowClick &&
                'hover:bg-accent/40 cursor-pointer transition-colors',
              activeKey === row.key && 'bg-accent/50'
            )}
          >
            <td className="border-border text-foreground border-b py-2 last:border-b-0">
              {row.label}
            </td>
            <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
              {row.sessionCount}
            </td>
            <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
              ${row.totalCostUsd.toFixed(2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
