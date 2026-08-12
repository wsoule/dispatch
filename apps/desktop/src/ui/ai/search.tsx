import { SearchIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';

import { cn } from '@/lib/utils';
import { Kbd } from '@/ui/kbd';

export type SearchItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  kbd?: string;
};

export type SearchGroup = {
  id: string;
  label: string;
  items: SearchItem[];
};

export type SearchPanelProps = {
  query: string;
  onQueryChange: (query: string) => void;
  groups: SearchGroup[];
  onSelect: (item: SearchItem) => void;
  emptyHint: string;
};

/** Filters `groups` to items whose label contains `query` (case-insensitive substring),
 * dropping any group left with no items. An empty (or whitespace-only) query returns
 * `groups` unchanged. Pure — the sole piece of logic in this primitive, unit-tested. */
export function filterGroups(
  groups: SearchGroup[],
  query: string
): SearchGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        item.label.toLowerCase().includes(needle)
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function flattenItems(groups: SearchGroup[]): SearchItem[] {
  return groups.flatMap((group) => group.items);
}

/** Overlay-style command search: a borderless input row (search icon, hairline divider
 * below) over grouped, keyboard-navigable results. Arrow keys move the active row
 * (`bg-surface-hover`, wrapping at either end); Enter selects it; hovering a row also
 * makes it active. Shows a centered muted icon + `emptyHint` when nothing matches.
 * Matches the showcase's "Search" primitive, extended with groups and `ui/kbd.tsx`
 * hints per the primitive brief. Fully controlled — `query`/`onQueryChange` live with
 * the caller. */
export function SearchPanel({
  query,
  onQueryChange,
  groups,
  onSelect,
  emptyHint,
}: SearchPanelProps) {
  const filtered = filterGroups(groups, query);
  const flat = flattenItems(filtered);
  const [activeId, setActiveId] = useState<string | null>(flat[0]?.id ?? null);
  const resolvedActiveId = flat.some((item) => item.id === activeId)
    ? activeId
    : (flat[0]?.id ?? null);

  // Recomputes the match set for the next query synchronously (rather than via an
  // effect) so the active row resets to the top result in the same event that changes
  // the query, never flashing a stale highlight.
  function handleInputChange(next: string) {
    const nextFlat = flattenItems(filterGroups(groups, next));
    setActiveId(nextFlat[0]?.id ?? null);
    onQueryChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (flat.length === 0) return;
    const currentIndex = flat.findIndex((item) => item.id === resolvedActiveId);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = flat[(currentIndex + 1) % flat.length];
      if (next) setActiveId(next.id);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = flat[(currentIndex - 1 + flat.length) % flat.length];
      if (previous) setActiveId(previous.id);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = flat[currentIndex] ?? flat[0];
      if (active) onSelect(active);
    }
  }

  return (
    <div className="rounded-card bg-card shadow-overlay flex w-full flex-col overflow-hidden">
      <div className="shadow-hairline-bottom flex h-10 shrink-0 items-center gap-2 px-3">
        <SearchIcon
          aria-hidden
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <input
          value={query}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search…"
          aria-label="Search"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="search-panel-results"
          aria-activedescendant={
            resolvedActiveId ? `search-item-${resolvedActiveId}` : undefined
          }
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>

      {flat.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
          <span
            aria-hidden
            className="bg-surface-inset text-muted-foreground shadow-hairline rounded-control flex size-8 items-center justify-center"
          >
            <SearchIcon className="size-3.5" />
          </span>
          <span className="text-muted-foreground text-[12.5px]">
            {emptyHint}
          </span>
        </div>
      ) : (
        <div
          id="search-panel-results"
          role="listbox"
          aria-label="Search results"
          className="flex flex-col gap-0.5 overflow-y-auto p-1"
        >
          {filtered.map((group) => (
            <div key={group.id}>
              <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10.5px] font-medium tracking-[0.08em] uppercase first:pt-1">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const isActive = item.id === resolvedActiveId;
                  return (
                    <button
                      key={item.id}
                      id={`search-item-${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveId(item.id)}
                      onClick={() => onSelect(item)}
                      className={cn(
                        'rounded-control flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] transition-colors duration-100',
                        isActive ? 'bg-surface-hover' : ''
                      )}
                    >
                      {item.icon && (
                        <span
                          aria-hidden
                          className="text-muted-foreground shrink-0"
                        >
                          {item.icon}
                        </span>
                      )}
                      <span className="text-foreground min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {item.hint && (
                        <span className="text-muted-foreground shrink-0 truncate text-[11.5px]">
                          {item.hint}
                        </span>
                      )}
                      {item.kbd && <Kbd className="shrink-0">{item.kbd}</Kbd>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
