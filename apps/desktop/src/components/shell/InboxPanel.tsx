import type { ReactNode } from 'react';

import {
  DECISION_KIND_LABELS,
  type DecisionItem,
} from '../../lib/decisionFeed';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { InboxEntry, InboxTarget } from '../../lib/inbox';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { ScrollArea } from '@/ui/scroll-area';

interface InboxPanelProps {
  /** The daemon's decision feed, server order (open longest-waiting first,
   * then the just-resolved tail) — the "Waiting on you" section. */
  decisions: DecisionItem[];
  /** Deep-links the clicked decision to the surface where it is answered —
   * `openDecision` in App, which also closes the popover. */
  onOpenDecision: (item: DecisionItem) => void;
  entries: InboxEntry[];
  /** Routes the clicked entry to its record/page — `navigateFromInbox` in App, which also
   * closes the popover and marks the inbox read. */
  onNavigate: (target: InboxTarget) => void;
  onMarkAllRead: () => void;
}

/**
 * The notification center's panel body, rendered inside the titlebar bell's
 * `PopoverContent` (see `TitleBar`), which owns anchoring, dismissal, and the
 * popover chrome. Two sections with different lifecycles:
 *
 * - "Waiting on you" — the daemon's decision feed. No read state anywhere: an
 *   item leaves when the underlying gate is decided, and a just-resolved item
 *   lingers dimmed for the daemon's short retention window so it settles in
 *   view rather than vanishing mid-read.
 * - "Earlier" — the persisted record of run/queue transitions, which the
 *   system cannot observe being "handled", so those keep manual mark-as-read.
 *
 * Bodies wrap in full rather than clamping — a notification you cannot finish
 * reading is a notification that failed.
 */
export function InboxPanel({
  decisions,
  onOpenDecision,
  entries,
  onNavigate,
  onMarkAllRead,
}: InboxPanelProps) {
  const empty = decisions.length === 0 && entries.length === 0;
  const openCount = decisions.filter((d) => d.state === 'open').length;

  return (
    <div className="flex max-h-[70vh] flex-col overflow-hidden">
      <div className="shadow-hairline-bottom flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-foreground text-[13px] font-medium">
          Notifications
        </span>
        {entries.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onMarkAllRead}
            className="text-muted-foreground hover:text-foreground h-auto p-0 text-[11px] font-normal hover:bg-transparent"
          >
            Mark all read
          </Button>
        )}
      </div>
      {/* min-h-0 lets this flex child shrink below its content height so it scrolls instead
          of growing past the panel's max-h and getting hard-clipped. */}
      <ScrollArea className="min-h-0">
        {empty ? (
          <EmptyState message="Nothing waiting on you." />
        ) : (
          <>
            {decisions.length > 0 && (
              <section aria-label="Waiting on you">
                <SectionHeading>
                  Waiting on you{openCount > 0 ? ` · ${openCount}` : ''}
                </SectionHeading>
                <div className="[&>*+*]:shadow-hairline-top">
                  {decisions.map((item) => (
                    <DecisionRow
                      key={item.id}
                      item={item}
                      onOpen={onOpenDecision}
                    />
                  ))}
                </div>
              </section>
            )}
            {entries.length > 0 && (
              <section aria-label="Earlier">
                {decisions.length > 0 && (
                  <SectionHeading>Earlier</SectionHeading>
                )}
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
              </section>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="shadow-hairline-bottom text-muted-foreground px-3 pt-2 pb-1.5 text-[10px] font-medium tracking-wide uppercase">
      {children}
    </div>
  );
}

/**
 * One decision, still clickable after it resolves — the destination (the task,
 * the run) outlives the gate, and "where did that go?" deserves a door too.
 * The age is rendered from `since` (when it started waiting), which is the
 * escalation signal the feed sorts by.
 */
function DecisionRow({
  item,
  onOpen,
}: {
  item: DecisionItem;
  onOpen: (item: DecisionItem) => void;
}) {
  const resolved = item.state === 'resolved';
  // Summaries for run-scoped kinds already lead with the task title; only add
  // the title line when it would say something the summary doesn't.
  const title =
    item.taskTitle !== undefined && !item.summary.includes(item.taskTitle)
      ? item.taskTitle
      : undefined;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onOpen(item)}
      className={cn(
        'hover:bg-surface-hover ease-out-expo flex h-auto w-full flex-col items-start justify-start gap-0.5 rounded-none px-3 py-2 text-left font-normal whitespace-normal transition-colors duration-100',
        resolved && 'opacity-50'
      )}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">
            {resolved ? 'Resolved' : DECISION_KIND_LABELS[item.kind]}
          </span>
          {title !== undefined && (
            <span className="text-muted-foreground min-w-0 truncate text-[11px]">
              {title}
            </span>
          )}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
          {formatRelativeTimeFromIso(item.since)}
        </span>
      </span>
      <span className="text-foreground text-[13px]">{item.summary}</span>
      {item.reason !== undefined && item.kind === 'scope-request' && (
        <span className="text-muted-foreground text-[12px]">{item.reason}</span>
      )}
    </Button>
  );
}
