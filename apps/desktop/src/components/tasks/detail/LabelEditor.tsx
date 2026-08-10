import { X } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

// The labels editor in the rail: existing labels as removable chips plus an
// input that adds a label on Enter. Labels are freeform strings, so this is a
// plain add/remove rather than a pick-from-list — deduped and trimmed before it
// calls back with the whole new list (matching UpdatePatch.labels' shape).
export function LabelEditor({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const label = draft.trim();
    if (label !== '' && !labels.includes(label)) onChange([...labels, label]);
    setDraft('');
  }
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5">
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <Badge
              key={label}
              variant="secondary"
              className="gap-1 pr-1 text-[11px]"
            >
              {label}
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove label ${label}`}
                className="text-muted-foreground hover:text-foreground size-auto p-0 hover:bg-transparent has-[>svg]:px-0"
                onClick={() => onChange(labels.filter((l) => l !== label))}
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        className="h-7 text-[12px]"
        placeholder="Add label…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
        onBlur={add}
      />
    </div>
  );
}
