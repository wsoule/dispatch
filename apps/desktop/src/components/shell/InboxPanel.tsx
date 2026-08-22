import { useEffect, useRef } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import type { InboxEntry, InboxTarget } from '../../lib/inbox';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { ScrollArea } from '@/ui/scroll-area';

interface InboxPanelProps {
  /** Newest-first inbox entries — `data.inbox.entries`, unfiltered (read/unread both show,
   * with read rows muted). */
  entries: InboxEntry[];
  /** Click-through — App.tsx maps this onto its existing NavActions (run → that run's task;
   * queue/runs-page → the Inbox). */
  onNavigate: (target: InboxTarget) => void;
  /** The header's manual "Mark all read" action — separate from the auto-mark-on-open App.tsx
   * does when the panel opens, so entries that arrive while it's already open can still be
   * cleared without closing and reopening. */
  onMarkAllRead: () => void;
  onClose: () => void;
}

/**
 * The notification inbox popover — the recoverable record behind every transient run/queue
 * toast (see notificationEdges.ts and useTransitionNotifications.ts). Deliberately a plain
 * absolute-positioned panel, not a Radix dialog: it only needs outside-click/Escape
 * dismissal, not focus-trap/portal semantics, so a hand-rolled listener pair keeps it simple.
 */
export function InboxPanel({
  entries,
  onNavigate,
  onMarkAllRead,
  onClose,
}: InboxPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Outside click or Escape both dismiss the panel — the same "lightweight popover" contract
  // as clicking the bell again, just from outside the panel instead of on its trigger.
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (
        panelRef.current !== null &&
        !panelRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      className="bg-popover rounded-card shadow-overlay fixed top-11 right-3 z-50 flex max-h-[70vh] w-80 flex-col overflow-hidden"
    >
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
          entries.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              variant="ghost"
              onClick={() => onNavigate(entry.target)}
              className={cn(
                'hover:bg-accent/60 shadow-hairline-bottom flex h-auto w-full flex-col items-start justify-start gap-0.5 rounded-none px-3 py-2 text-left font-normal last:shadow-none',
                entry.read && 'opacity-60'
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-foreground truncate text-[13px] font-medium">
                  {entry.title}
                </span>
                <span className="text-muted-foreground shrink-0 text-[11px]">
                  {formatRelativeTimeFromIso(entry.ts)}
                </span>
              </span>
              <span className="text-muted-foreground line-clamp-2 text-[12px]">
                {entry.body}
              </span>
            </Button>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
