import type { NormalizedEntry } from '@dispatch/client';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { formatElapsed } from '@/lib/draftTray';
import { ShimmerLabel } from '@/ui/ai/shimmer';
import { Button } from '@/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';

// Below this many steps a fold costs more than it saves, so the rows show as they are.
const MIN_FOLDED_STEPS = 3;

// The span from a group's first entry to its last, from their log timestamps. Entries with
// an unparseable `ts` are skipped; one usable stamp or none reads as zero.
export function workSpanMs(entries: readonly NormalizedEntry[]): number {
  const stamps = entries
    .map((entry) => Date.parse(entry.ts))
    .filter((stamp) => Number.isFinite(stamp));
  if (stamps.length < 2) return 0;
  return Math.max(...stamps) - Math.min(...stamps);
}

/**
 * T3 Code's turn fold: a run of tool calls collapses behind one quiet "Worked for 12s ·
 * 5 steps" line, so a long session reads as its prose with the work tucked between. While
 * the group is still `live` it stays open and the header shimmers "Working…"; once settled
 * it starts closed. Short groups skip the fold entirely.
 */
export function WorkFold({
  entries,
  live,
  children,
}: {
  entries: readonly NormalizedEntry[];
  live: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(live);
  if (entries.length < MIN_FOLDED_STEPS) {
    return <div className="flex flex-col">{children}</div>;
  }
  const span = formatElapsed(workSpanMs(entries));
  const steps = `${entries.length} steps`;
  const label = live ? `Working for ${span}` : `Worked for ${span}`;
  return (
    <Collapsible
      open={live || open}
      onOpenChange={setOpen}
      data-slot="work-fold"
      className="border-border/60 flex flex-col border-b pt-1 pb-2"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="group/fold text-muted-foreground hover:text-foreground h-6 justify-start gap-1 self-start px-0.5 text-[13px] font-normal tabular-nums hover:bg-transparent"
          />
        }
      >
        {live ? <ShimmerLabel>{label}</ShimmerLabel> : label}
        <span className="text-muted-foreground/70">· {steps}</span>
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 opacity-70 transition-transform duration-200 group-data-[panel-open]/fold:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col pt-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
