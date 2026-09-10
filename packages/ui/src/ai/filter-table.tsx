export type FilterChipOption = { id: string; label: string };

export type FilterChipsProps = {
  options: FilterChipOption[];
  active: string[];
  onToggle: (id: string) => void;
  counts?: Record<string, number>;
  /** Wrap chips onto multiple lines instead of the default single scrolling row — for a
   * chip set living inside a fixed-width popover rather than a full-width toolbar. */
  wrap?: boolean;
};

// Selects the subset of `rows` whose status (via `getStatus`) is in `active`. An empty
// `active` array means "no filter applied" — every row passes — matching the showcase's
// "All" chip semantics. Multiple active statuses union: a row matching any one of them
// passes. Row order is preserved rather than grouped by status.
export function filterRows<T>(
  rows: T[],
  active: string[],
  getStatus: (row: T) => string
): T[] {
  if (active.length === 0) return rows;
  return rows.filter((row) => active.includes(getStatus(row)));
}

/** Pill row of status filters: each option toggles independently (multi-select), an
 * optional count badge shows how many rows currently carry that status. Inactive chips
 * sit on `bg-surface-inset`; active ones wash `bg-accent-tint` with `text-primary` and
 * a matching badge. Matches the showcase's "Filter Table" chip row. Purely
 * presentational — callers own the `active` array and status vocabulary; pair with
 * `filterRows` to apply the selection. */
export function FilterChips({
  options,
  active,
  onToggle,
  counts,
  wrap = false,
}: FilterChipsProps) {
  return (
    <div
      className={`-mx-1 mb-1 flex items-center gap-1 px-1 py-1 ${
        wrap ? 'flex-wrap' : 'overflow-x-auto'
      }`}
      style={{ scrollbarWidth: 'none' }}
    >
      {options.map((option) => {
        const isActive = active.includes(option.id);
        const count = counts?.[option.id];
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(option.id)}
            className={`ease-out-expo flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,box-shadow,color] duration-200 ${
              isActive
                ? 'bg-accent-tint text-primary shadow-btn'
                : 'bg-surface-inset text-muted-foreground hover:bg-surface-hover'
            }`}
          >
            {option.label}
            {count !== undefined && (
              <span
                className={`rounded-[4px] px-1 text-[10.5px] tabular-nums ${
                  isActive ? 'bg-card text-primary' : 'text-muted-foreground'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
