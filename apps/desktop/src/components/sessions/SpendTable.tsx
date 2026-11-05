import { EmptyState, Register, RegisterCell, RegisterRow } from '@dispatch/ui';

interface SpendRow {
  key: string;
  /** The row's name ("Opus 4", "dispatch"); also the clickable row's accessible name. */
  label: string;
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

// The name takes the room; the session count and the spend are short end-aligned figures.
// The minimums (two 96px figures, the gaps and padding) fit well inside 480px, the
// register's `stackWithin` step, so both tables stay tables at the default window size.
const COLUMNS = 'minmax(0, 1fr) 96px 96px';

/**
 * The "sessions + spend, grouped by X" table the Sessions hub renders for both its "spend by
 * model" and "spend by project" sections — one shared component owns the markup, each caller
 * only supplies its own rows and the label for the grouping column. Built on @dispatch/ui's
 * Register: a name cell, then the session count and the `$x.xx` spend end-aligned in
 * tabular figures. Optionally clickable (see `onRowClick`) so the same table doubles as the
 * project filter control: each row is then a native button row (Enter and Space activate
 * it) whose stretched button exposes the active filter as `aria-pressed`, and the active row
 * takes the selected tint and a `data-active` hook. Rows stack into cards while the register
 * is under 480px wide.
 */
export function SpendTable({
  columnLabel,
  rows,
  emptyMessage,
  onRowClick,
  activeKey,
}: SpendTableProps) {
  if (rows.length === 0) {
    return <EmptyState>{emptyMessage}</EmptyState>;
  }

  return (
    <Register
      label={`${columnLabel} spend`}
      columns={COLUMNS}
      stackWithin={480}
      header={[
        { id: 'name', label: columnLabel },
        { id: 'sessions', label: 'Sessions', align: 'end' },
        { id: 'spend', label: 'Spend', align: 'end' },
      ]}
    >
      {rows.map((row) => {
        const cells = (
          <>
            <RegisterCell label={columnLabel} variant="name">
              {row.label}
            </RegisterCell>
            <RegisterCell label="Sessions" variant="mono" align="end">
              {row.sessionCount}
            </RegisterCell>
            <RegisterCell label="Spend" variant="mono" align="end">
              {`$${row.totalCostUsd.toFixed(2)}`}
            </RegisterCell>
          </>
        );
        if (onRowClick === undefined) {
          return <RegisterRow key={row.key}>{cells}</RegisterRow>;
        }
        const active = activeKey === row.key;
        return (
          <RegisterRow
            key={row.key}
            onActivate={() => onRowClick(row.key)}
            rowLabel={row.label}
            pressed={active}
            selected={active}
            data-active={active ? '' : undefined}
          >
            {cells}
          </RegisterRow>
        );
      })}
    </Register>
  );
}
