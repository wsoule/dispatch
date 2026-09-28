import type { DocSummary } from '@dispatch/client';
import { useId } from 'react';

import type { DocFilter } from '../../lib/docs';
import { docBadges } from '../../lib/docs';
import { cn } from '@/lib/utils';
import { Input } from '@/ui/input';
import { Toggle } from '@/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

const SCOPES: { id: DocFilter['scope']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'team', label: 'Team' },
  { id: 'personal', label: 'Personal' },
];

interface DocListProps {
  docs: readonly DocSummary[];
  filter: DocFilter;
  onFilter: (next: DocFilter) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  error: Error | null;
}

// The Docs view's left pane: search, the scope, archived and unreviewed
// filters, and one row per doc named by its title, badges as its description.
export function DocList({
  docs,
  filter,
  onFilter,
  selected,
  onSelect,
  error,
}: DocListProps) {
  const idPrefix = useId();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-[var(--color-border)] p-2">
        <Input
          aria-label="Search docs"
          placeholder="Search docs"
          value={filter.query}
          onChange={(e) => onFilter({ ...filter, query: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-1">
          <ToggleGroup
            size="sm"
            aria-label="Scope"
            value={[filter.scope]}
            onValueChange={([value]) => {
              const scope = SCOPES.find((s) => s.id === value);
              // Re-pressing the active scope hands back an empty list; keep it.
              if (scope !== undefined) onFilter({ ...filter, scope: scope.id });
            }}
          >
            {SCOPES.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id}>
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Toggle
            size="sm"
            pressed={filter.status === 'archived'}
            onPressedChange={(on) =>
              onFilter({ ...filter, status: on ? 'archived' : 'active' })
            }
          >
            Archived
          </Toggle>
          <Toggle
            size="sm"
            pressed={filter.unreviewedOnly}
            onPressedChange={(on) =>
              onFilter({ ...filter, unreviewedOnly: on })
            }
          >
            Unreviewed
          </Toggle>
        </div>
      </div>
      {error !== null && (
        <p className="p-3 text-xs text-[var(--color-destructive)]">
          {error.message}
        </p>
      )}
      {docs.length === 0 && error === null && (
        <p className="p-3 text-xs text-[var(--color-muted-foreground)]">
          No docs.
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-auto p-1">
        {docs.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              aria-label={d.title}
              aria-describedby={`${idPrefix}-${d.id}`}
              aria-current={selected === d.id ? 'true' : undefined}
              onClick={() => onSelect(d.id)}
              className={cn(
                'flex w-full flex-col items-start gap-1 rounded-control px-2 py-1.5 text-left hover:bg-surface-control',
                selected === d.id && 'bg-surface-selected'
              )}
            >
              <span className="w-full truncate text-[13px]">{d.title}</span>
              <span id={`${idPrefix}-${d.id}`} className="flex flex-wrap gap-1">
                {docBadges(d).map((b) => (
                  <span
                    key={b}
                    className="rounded bg-[var(--color-muted)] px-1 text-[10px] text-[var(--color-muted-foreground)]"
                  >
                    {b}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
