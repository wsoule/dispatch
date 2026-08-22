import type { DraftRecord } from '@dispatch/client';
import { Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { draftTrayViewModel } from '../../lib/draftTray';
import { cn } from '@/lib/utils';
import { TaskRow, type TaskRowState } from '@/ui/ai/task-rows';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { CountChip } from '@/ui/chrome/CountChip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { ScrollArea } from '@/ui/scroll-area';

// The tray's own item states mapped onto `TaskRow`'s vocabulary: a ready proposal is 'done'
// (review color — it is waiting to be reviewed), the rest map by name.
const ROW_STATE: Record<'running' | 'ready' | 'failed', TaskRowState> = {
  running: 'running',
  ready: 'done',
  failed: 'failed',
};

interface DraftTrayProps {
  /** Every draft currently held in memory, newest first — `data.drafts`. */
  drafts: DraftRecord[];
  /** Opens the review dialog for a ready draft. */
  onOpenDraft: (id: string) => void;
  onDismissDraft: (id: string) => void;
}

/** App-wide popover of in-flight and settled AI task drafts, reachable from the titlebar
 * regardless of which view is open — a draft keeps running after its composer closes. */
export function DraftTray({
  drafts,
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
        {/* Compact titlebar trigger: icon plus the count pill when anything is pending. The
            pill keeps its status colouring — a waiting question is the one count that doubles
            as a state and needs to stand out even at this size. */}
        <Button
          type="button"
          variant="ghost"
          title="AI task drafts"
          aria-label={`AI task drafts${badgeCount > 0 ? ` (${badgeCount})` : ''}${
            questionCount > 0 ? ', waiting on your answer' : ''
          }`}
          className="text-foreground/80 hover:bg-accent/60 hover:text-foreground/80 h-7 shrink-0 gap-1 rounded-md px-1.5 text-[13px] font-normal transition-colors duration-150"
        >
          <Sparkles className="size-4 shrink-0" strokeWidth={2} />
          {badgeCount > 0 && (
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
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-[26rem] p-0">
        <div className="shadow-hairline-bottom px-3 py-2">
          <span className="text-foreground text-[13px] font-medium">
            AI task drafts
          </span>
        </div>
        <ScrollArea className="max-h-[60vh]">
          {items.length === 0 ? (
            <EmptyState message='No drafts yet. Start one from "New task".' />
          ) : (
            <div className="[&>*+*]:shadow-hairline-top">
              {items.map((item) => (
                <TaskRow
                  key={item.id}
                  title={item.label}
                  agent="planner"
                  state={ROW_STATE[item.state]}
                  progress={
                    item.taskCount !== null && item.taskCount > 1
                      ? `${item.taskCount} tasks`
                      : undefined
                  }
                  elapsedLabel={item.elapsed}
                  onClick={
                    item.openable
                      ? () => {
                          onOpenDraft(item.id);
                          setOpen(false);
                        }
                      : undefined
                  }
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Dismiss draft"
                      onClick={(event) => {
                        // The row itself is clickable; a dismiss must not also open it.
                        event.stopPropagation();
                        onDismissDraft(item.id);
                      }}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <X className="size-3.5" />
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
