import type { DocLink } from '@dispatch/client';

// What the doc links to (tasks, runs, threads, memory, docs), one row per
// target as `type:id` with its rel.
export function DocLinksRail({ links }: { links: readonly DocLink[] }) {
  return (
    <aside
      aria-label="Links"
      className="w-56 shrink-0 overflow-auto border-l border-[var(--color-border)] p-3"
    >
      <h3 className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">
        Links
      </h3>
      {links.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No links yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {links.map((l) => (
            <li
              key={`${l.target.type}:${l.target.id}:${l.rel}:${l.source}`}
              className="flex items-center gap-1.5"
            >
              <span className="truncate font-mono">{`${l.target.type}:${l.target.id}`}</span>
              <span className="text-[var(--color-muted-foreground)]">
                {l.source === 'mention' ? 'mention' : l.rel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
