import type { DocSummary } from '@dispatch/client';
import type { KeyboardEvent } from 'react';
import { useId } from 'react';

import type { DocFilter } from '../../lib/docs';
import { docBadges } from '../../lib/docs';
import { resolveListKeyCommand } from '../../lib/keyboard';
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
  /** The list has not arrived yet. */
  loading?: boolean;
  /** `page` (Two views' All docs): filters on one line over full-width rows. */
  layout?: 'rail' | 'page';
}

// One All docs row at the Tasks list's density: glyph, title, then its tags.
function PageRow({
  doc,
  onSelect,
}: {
  doc: DocSummary;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={doc.title}
      onClick={() => onSelect(doc.id)}
      className="hover:bg-surface-hover focus-visible:bg-surface-hover flex h-9 w-full items-center gap-2 px-4 text-left text-[13px] outline-none"
    >
      <span aria-hidden className="text-muted-foreground">
        ▤
      </span>
      <span className="min-w-0 flex-1 truncate">{doc.title}</span>
      {docBadges(doc).map((b) => (
        <span
          key={b}
          className={cn(
            'rounded-chip text-muted-foreground shrink-0 px-1.5 text-[11px]',
            b === 'unreviewed'
              ? 'border border-dashed border-(--text-ghost)'
              : 'border-border-chip border-[0.5px]'
          )}
        >
          {b}
        </span>
      ))}
      <span className="text-muted-foreground w-40 shrink-0 truncate text-right font-mono text-[11px]">
        {doc.handle}
      </span>
    </button>
  );
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
  loading = false,
  layout = 'rail',
}: DocListProps) {
  const page = layout === 'page';
  const idPrefix = useId();
  // j/k (and the arrows) move the selection, as in the other lists.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const command = resolveListKeyCommand(event, { isTyping: false });
    if (command !== 'list-down' && command !== 'list-up') return;
    event.preventDefault();
    if (docs.length === 0) return;
    const at = docs.findIndex((d) => d.id === selected);
    const next =
      command === 'list-down'
        ? Math.min(at + 1, docs.length - 1)
        : Math.max(at === -1 ? 0 : at - 1, 0);
    onSelect(docs[next].id);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'flex gap-2',
          page
            ? 'shadow-hairline-bottom flex-wrap items-center px-4 py-2'
            : 'flex-col border-b border-[var(--color-border)] p-2'
        )}
      >
        <Input
          aria-label="Search docs"
          placeholder="Search docs"
          className={page ? 'h-7 w-[220px] text-[12px]' : undefined}
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
      {loading && docs.length === 0 && error === null && (
        <p className="p-3 text-xs text-[var(--color-muted-foreground)]">
          Loading docs…
        </p>
      )}
      {!loading && docs.length === 0 && error === null && (
        <p className="p-3 text-xs text-[var(--color-muted-foreground)]">
          No docs.
        </p>
      )}
      <ul
        aria-label="Docs"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={cn(
          'min-h-0 flex-1 overflow-auto outline-none',
          page ? 'py-1' : 'p-1'
        )}
      >
        {docs.map((d) =>
          page ? (
            <li key={d.id}>
              <PageRow doc={d} onSelect={onSelect} />
            </li>
          ) : (
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
                <span
                  id={`${idPrefix}-${d.id}`}
                  className="flex flex-wrap gap-1"
                >
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
          )
        )}
      </ul>
    </div>
  );
}
