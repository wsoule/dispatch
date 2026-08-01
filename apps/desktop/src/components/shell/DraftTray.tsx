import type { DraftRecord } from '@dispatch/client';
import { CircleAlert, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { draftTrayViewModel } from '../../lib/draftTray';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

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

/**
 * App-wide popover of in-flight and settled AI task drafts, reachable from the sidebar
 * regardless of which view is open — a draft keeps running server-side after its composer
 * closes, so this is the one place to come back and check on it.
 */
export function DraftTray({
  drafts,
  collapsed,
  onOpenDraft,
  onDismissDraft,
}: DraftTrayProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Ticks the elapsed readout once a second, but only while the popover is open and something
  // is still running — a closed tray, or one where every draft has already settled, has
  // nothing left to count up.
  useEffect(() => {
    if (!open || !drafts.some((d) => d.state === 'running')) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, drafts]);

  const { items, badgeCount } = draftTrayViewModel(drafts, now);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="AI task drafts"
          aria-label={
            collapsed
              ? `AI task drafts${badgeCount > 0 ? ` (${badgeCount})` : ''}`
              : undefined
          }
          className={cn(
            'text-foreground/80 hover:bg-accent/60 mb-0.5 flex items-center rounded-md py-1.5 text-left text-[13px] transition-colors duration-150',
            collapsed ? 'w-full justify-center' : 'w-full gap-2 px-2'
          )}
        >
          <Sparkles className="size-4 shrink-0" strokeWidth={2} />
          {!collapsed && (
            <>
              <span className="flex-1">Drafts</span>
              {badgeCount > 0 && (
                <span className="bg-secondary text-secondary-foreground flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium">
                  {badgeCount}
                </span>
              )}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-80 p-0">
        <div className="border-border border-b px-3 py-2">
          <span className="text-foreground text-[13px] font-medium">
            AI task drafts
          </span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-[13px]">
              No drafts yet — start one from "New task".
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="border-border/60 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
              >
                {item.state === 'running' && (
                  <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
                )}
                {item.state === 'failed' && (
                  <CircleAlert className="text-destructive size-3.5 shrink-0" />
                )}
                {item.state === 'ready' ? (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenDraft(item.id);
                      setOpen(false);
                    }}
                    className="hover:text-foreground min-w-0 flex-1 truncate text-left text-[13px]"
                  >
                    {item.label}
                  </button>
                ) : (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">
                    {item.label}
                  </span>
                )}
                <span className="text-muted-foreground shrink-0 text-[11px]">
                  {item.elapsed}
                </span>
                <button
                  type="button"
                  aria-label="Dismiss draft"
                  onClick={() => onDismissDraft(item.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
