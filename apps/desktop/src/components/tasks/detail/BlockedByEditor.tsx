import type { TaskDoc } from '@dispatch/core/browser';
import { Plus, X } from 'lucide-react';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

// The blocked-by editor in the rail: current blockers as removable chips (each
// showing the blocking task's id) plus a Select of the other tasks in the
// project to add one. Unlike labels this IS a pick-from-list — a blocker has to
// be a real task id — so the add control is a dropdown of candidates (self and
// already-listed blockers filtered out) rather than a free-text input.
export function BlockedByEditor({
  blockedBy,
  candidates,
  onChange,
}: {
  blockedBy: string[];
  candidates: TaskDoc[];
  onChange: (next: string[]) => void;
}) {
  const addable = candidates.filter((t) => !blockedBy.includes(t.meta.id));
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5">
      {blockedBy.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {blockedBy.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 pr-1 text-[11px]"
            >
              <span className="font-mono">{id}</span>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove blocker ${id}`}
                className="text-muted-foreground hover:text-foreground size-auto p-0 hover:bg-transparent has-[>svg]:px-0"
                onClick={() => onChange(blockedBy.filter((b) => b !== id))}
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      {addable.length > 0 && (
        // `key` on the Select resets it to the placeholder after each add, so it
        // never shows a stale "selected" blocker and can add several in a row.
        <Select
          key={blockedBy.join(',')}
          value=""
          onValueChange={(id) => onChange([...blockedBy, id])}
        >
          <SelectTrigger
            size="sm"
            aria-label="Add blocker"
            className="text-muted-foreground h-7 w-full justify-start gap-1.5 text-[12px] [&>svg]:hidden"
          >
            <Plus className="size-3.5" />
            {/* The label goes through SelectValue rather than a bare span: with
                `item-aligned` positioning Radix only places the open menu once
                it has a value node, so a trigger without one opens the list
                off-screen. */}
            <SelectValue placeholder="Add blocker" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((t) => (
              <SelectItem key={t.meta.id} value={t.meta.id}>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {t.meta.id}
                </span>
                <span className="truncate">{t.meta.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
