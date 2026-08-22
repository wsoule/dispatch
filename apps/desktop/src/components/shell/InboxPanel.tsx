import { formatRelativeTimeFromIso } from '../../lib/format';
import type { InboxEntry, InboxTarget } from '../../lib/inbox';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { ScrollArea } from '@/ui/scroll-area';

interface InboxPanelProps {
  entries: InboxEntry[];
  /** Routes the clicked entry to its record/page — `navigateFromInbox` in App, which also
   * closes the popover and marks the inbox read. */
  onNavigate: (target: InboxTarget) => void;
  onMarkAllRead: () => void;
}

/**
 * The notification inbox's panel body — header row plus one row per entry, newest first.
 * Purely content: it renders inside the titlebar bell's `PopoverContent` (see `TitleBar`),
 * which owns anchoring, dismissal, and the popover chrome. Bodies wrap in full rather than
 * clamping — a notification you cannot finish reading is a notification that failed.
 */
export function InboxPanel({
  entries,
  onNavigate,
  onMarkAllRead,
}: InboxPanelProps) {
  return (
    <div className="flex max-h-[70vh] flex-col overflow-hidden">
      <div className="shadow-hairline-bottom flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-foreground text-[13px] font-medium">
          Notifications
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onMarkAllRead}
          className="text-muted-foreground hover:text-foreground h-auto p-0 text-[11px] font-normal hover:bg-transparent"
        >
          Mark all read
        </Button>
      </div>
      {/* min-h-0 lets this flex child shrink below its content height so it scrolls instead
          of growing past the panel's max-h and getting hard-clipped. */}
      <ScrollArea className="min-h-0">
        {entries.length === 0 ? (
          <EmptyState message="No notifications yet." />
        ) : (
          <div className="[&>*+*]:shadow-hairline-top">
            {entries.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                variant="ghost"
                onClick={() => onNavigate(entry.target)}
                className={cn(
                  'hover:bg-surface-hover ease-out-expo flex h-auto w-full flex-col items-start justify-start gap-0.5 rounded-none px-3 py-2 text-left font-normal whitespace-normal transition-colors duration-100',
                  entry.read && 'opacity-60'
                )}
              >
                <span className="flex w-full items-baseline justify-between gap-2">
                  <span className="text-foreground min-w-0 text-[13px] font-medium">
                    {entry.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                    {formatRelativeTimeFromIso(entry.ts)}
                  </span>
                </span>
                <span className="text-muted-foreground text-[12px]">
                  {entry.body}
                </span>
              </Button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
