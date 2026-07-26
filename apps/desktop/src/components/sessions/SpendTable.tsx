import type { ReactNode } from 'react';

export interface SpendRow {
  key: string;
  label: ReactNode;
  sessionCount: number;
  totalCostUsd: number;
}

interface SpendTableProps {
  /** Header for the row-identity column, e.g. "Project" / "Tag" / "Agent". */
  columnLabel: string;
  rows: SpendRow[];
  emptyMessage: string;
}

/**
 * The "sessions + spend, grouped by X" table `ReportView` rendered three times (by project, by
 * tag, by agent) as three near-identical `<table>` blocks. One shared component now owns the
 * markup; each caller only supplies its own rows and the label for the grouping column.
 */
export function SpendTable({
  columnLabel,
  rows,
  emptyMessage,
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
          <tr key={row.key}>
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
