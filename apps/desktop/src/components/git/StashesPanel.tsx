import type { GitStash } from '@dispatch/client';
import { Trash2, Undo2 } from 'lucide-react';

import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface StashesPanelProps {
  stashes: GitStash[];
  loading: boolean;
  busy: boolean;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onPop: (index: number) => void;
  onRequestDrop: (stash: GitStash) => void;
}

/** Panel 5: the stash list. Pop and drop are both one click; drop routes through the caller's
 * confirmation dialog since it's the one irreversible stash action. */
export function StashesPanel({
  stashes,
  loading,
  busy,
  selectedIndex,
  onSelectIndex,
  onPop,
  onRequestDrop,
}: StashesPanelProps) {
  if (loading) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">Loading…</div>
    );
  }
  if (stashes.length === 0) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">No stashes.</div>
    );
  }

  return (
    <div className="flex flex-col">
      {stashes.map((stash, index) => (
        <div
          key={stash.ref}
          data-git-selected={index === selectedIndex ? 'true' : undefined}
          onClick={() => onSelectIndex(index)}
          role="button"
          tabIndex={-1}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-[12px]',
            index === selectedIndex ? 'bg-accent' : 'hover:bg-muted/50'
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate">{stash.message}</span>
            <span className="text-muted-foreground text-[10.5px]">
              {formatRelativeTimeFromIso(stash.date)}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label="Pop (S)"
                onClick={(e) => {
                  e.stopPropagation();
                  onPop(stash.index);
                }}
              >
                <Undo2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pop (S)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                className="hover:text-destructive"
                aria-label="Drop"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDrop(stash);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Drop</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
