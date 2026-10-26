import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Pill } from '@/ui/ai/pill';

/**
 * The declared write set as mono pills, each removable, with a field that adds a path or
 * glob on Enter. The fan-out schedules around these, so they are worth keeping exact.
 * (Legacy styling, hosted in the task page's Writes section until Phase 7 restyles it.)
 */
export function WritesEditor({
  writes,
  onChange,
}: {
  writes: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const glob = draft.trim();
    setDraft('');
    if (glob === '' || writes.includes(glob)) return;
    onChange([...writes, glob]);
  }
  return (
    <div
      data-slot="writes-editor"
      className="flex flex-wrap items-center gap-1.5"
    >
      {writes.map((glob) => (
        <Pill key={glob} className="font-mono font-normal">
          {glob}
          <button
            type="button"
            aria-label={`Remove ${glob}`}
            className="text-muted-foreground hover:text-foreground rounded-pill focus-visible:ring-ring -mr-1 flex size-4 items-center justify-center outline-none focus-visible:ring-2"
            onClick={() => onChange(writes.filter((w) => w !== glob))}
          >
            <X className="size-3" />
          </button>
        </Pill>
      ))}
      <label className="text-muted-foreground focus-within:text-foreground flex h-6 min-w-40 flex-1 items-center gap-1 text-[12px]">
        <Plus aria-hidden className="size-3 shrink-0" />
        <input
          aria-label="Add a write path"
          placeholder={writes.length === 0 ? 'Add a path or glob…' : 'Add…'}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
      </label>
    </div>
  );
}
