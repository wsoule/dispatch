import type { DraftRecord } from '@dispatch/client';
import { CircleAlert, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { draftTrayViewModel } from '../../lib/draftTray';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { CountChip } from '@/ui/chrome/CountChip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { ScrollArea } from '@/ui/scroll-area';
import { Spinner } from '@/ui/spinner';

interface DraftTrayProps {
  /** Every draft currently held in memory, newest first — `data.drafts`. */
  drafts: DraftRecord[];
  /** Whether the sidebar is collapsed to its icon-only strip — matches every other row's
   * label/aria-label split. */
  collapsed: boolean;
  /** Opens the review dialog for a ready draft. */
  onOpenDraft: (id: string) => void;
  onDismissDraft: (id: string) => void;
}

/** App-wide popover of in-flight and settled AI task drafts, reachable from the sidebar
 * regardless of which view is open — a draft keeps running after its composer closes. */
export function DraftTray({
  drafts,
  collapsed,
  onOpenDraft,
  onDismissDraft,
}: DraftTrayProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { items, badgeCount, hasRunning, questionCount } = draftTrayViewModel(
    drafts,
    now
  );

  // Ticks the elapsed readout once a second, but only while the popover is open and something
  // is still running.
  useEffect(() => {
    if (!open || !hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, hasRunning]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          title="AI task drafts"
          aria-label={
            collapsed
              ? `AI task drafts${badgeCount > 0 ? ` (${badgeCount})` : ''}${
                  questionCount > 0 ? ', waiting on your answer' : ''
                }`
              : undefined
          }
          className={cn(
            'h-auto mb-0.5 rounded-md py-1.5 text-left text-[13px] font-normal text-foreground/80 hover:bg-accent/60 hover:text-foreground/80 transition-colors duration-150',
            collapsed
              ? 'w-full px-0 has-[>svg]:px-0'
              : 'w-full justify-start px-2 has-[>svg]:px-2'
          )}
        >
          <Sparkles className="size-4 shrink-0" strokeWidth={2} />
          {!collapsed && (
            <>
              <span className="flex-1">Drafts</span>
              {badgeCount > 0 && (
                // CountChip is deliberately colorless everywhere else, but this badge is the
                // one place a count doubles as a status (a waiting question needs to stand
                // out), so its pill styling is preserved via className, overriding
                // dense-meta's mono/tabular-nums treatment back to the original look.
                <CountChip
                  count={badgeCount}
                  className={cn(
                    'flex min-w-[1.1rem] items-center justify-center rounded-full px-1 font-sans text-[10px] font-medium tracking-normal normal-nums',
                    questionCount > 0
                      ? 'bg-state-waiting-surface text-state-waiting border-state-waiting-edge border'
                      : 'bg-secondary text-secondary-foreground'
                  )}
                />
              )}
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-80 p-0">
        <div className="shadow-hairline-bottom px-3 py-2">
          <span className="text-foreground text-[13px] font-medium">
            AI task drafts
          </span>
        </div>
        <ScrollArea className="max-h-[60vh]">
          {items.length === 0 ? (
            <EmptyState message='No drafts yet. Start one from "New task".' />
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="shadow-hairline-bottom flex items-center gap-2 px-3 py-2 last:shadow-none"
              >
                {item.state === 'running' && (
                  <Spinner className="text-primary size-3.5 shrink-0" />
                )}
                {item.state === 'failed' && (
                  <CircleAlert className="text-destructive size-3.5 shrink-0" />
                )}
                {item.openable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      onOpenDraft(item.id);
                      setOpen(false);
                    }}
                    className="h-auto min-w-0 flex-1 justify-start truncate px-1.5 py-1 text-left text-[13px] font-normal"
                  >
                    {item.label}
                  </Button>
                ) : (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">
                    {item.label}
                  </span>
                )}
                <span className="text-muted-foreground shrink-0 text-[11px]">
                  {item.elapsed}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss draft"
                  onClick={() => onDismissDraft(item.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
