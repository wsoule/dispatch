import type { MemoryEntryView } from '@dispatch/client';

import { entryProvenance } from '../../lib/memory';

/** One tab's entries: title, handle and where each came from. */
export function MemoryList({
  entries,
  selected,
  onSelect,
}: {
  entries: readonly MemoryEntryView[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (entries.length === 0)
    return (
      <p className="text-muted-foreground p-4 text-[13px]">Nothing here yet.</p>
    );
  return (
    <ul aria-label="Memory entries" className="flex flex-col">
      {entries.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            aria-current={e.id === selected ? 'true' : undefined}
            onClick={() => onSelect(e.id)}
            className="rounded-control hover:bg-surface-hover aria-[current=true]:bg-surface-selected flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
          >
            <span className="text-foreground text-[13px] break-words">
              {e.title}
            </span>
            <span className="text-muted-foreground text-[12px]">
              {`${e.handle} · ${entryProvenance(e)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
