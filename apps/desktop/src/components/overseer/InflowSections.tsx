import type { DraftRecord } from '@dispatch/client';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { draftTrayViewModel } from '../../lib/draftTray';
import type { FeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { InboxEntry } from '../../lib/inbox';
import { IconButton } from '@/ui/ai/icon-button';
import { ListRow } from '@/ui/ai/list-row';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome';
import { CollapseBar } from '@/ui/chrome/collapse-bar';
import { StateMark } from '@/ui/chrome/state-mark';

/** How many notifications show before "+N more". */
const NOTIFICATIONS_SHOWN = 5;

// A draft's mark: still drafting, waiting on your answers, ready to review, or failed.
function draftMark(draft: DraftRecord | undefined): FeedState {
  if (draft === undefined) return 'working';
  if (draft.state === 'running') return 'working';
  if (draft.questions.length > 0) return 'answer';
  return draft.state === 'ready' ? 'review' : 'failed';
}

// What a draft row says after its title.
function draftCrumb(
  draft: DraftRecord | undefined,
  taskCount: number | null
): string {
  if (draft === undefined || draft.state === 'running') return 'drafting';
  const questions = draft.questions.length;
  if (questions > 0) {
    return questions === 1 ? '1 question' : `${questions} questions`;
  }
  if (draft.state === 'failed') return 'failed';
  return taskCount !== null && taskCount > 1 ? `${taskCount} tasks` : 'ready';
}

/**
 * The AI task drafts in Coming in: what is still drafting, what waits on your
 * answers, and what is ready to review. A row opens the draft page; the cross
 * dismisses it. Renders nothing without drafts.
 */
export function DraftsSection({
  drafts,
  onOpen,
  onDismiss,
}: {
  drafts: readonly DraftRecord[];
  onOpen: (draftId: string) => void;
  onDismiss: (draftId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const { items, hasRunning } = draftTrayViewModel([...drafts], now);
  // The elapsed readout ticks only while something is still drafting.
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);
  if (items.length === 0) return null;
  const byId = new Map(drafts.map((d) => [d.id, d]));
  return (
    <section
      aria-label="Drafts"
      data-testid="overseer-drafts"
      className="flex flex-col"
    >
      <SectionLabel count={items.length} className="px-2 pb-0.5">
        Drafts
      </SectionLabel>
      <div role="list" className="flex flex-col">
        {items.map((item) => {
          const draft = byId.get(item.id);
          return (
            <ListRow
              key={item.id}
              role="listitem"
              data-testid="overseer-draft-row"
              onClick={() => onOpen(item.id)}
              leading={<StateMark state={draftMark(draft)} />}
              title={item.label}
              crumb={draftCrumb(draft, item.taskCount)}
              trailing={
                <IconButton
                  label="Dismiss draft"
                  onClick={(event) => {
                    // The row opens the draft; dismissing must not also open it.
                    event.stopPropagation();
                    onDismiss(item.id);
                  }}
                >
                  <X />
                </IconButton>
              }
              date={item.elapsed}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * The notification history in Coming in: every run and merge transition the
 * app recorded, newest first, unread ones marked. A row opens what it is
 * about; "Mark all read" clears the unread count. Renders nothing while the
 * history is empty.
 */
export function NotificationsSection({
  entries,
  unreadCount,
  onMarkAllRead,
  onOpen,
}: {
  entries: readonly InboxEntry[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onOpen: (entry: InboxEntry) => void;
}) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;
  const shown = all ? entries : entries.slice(0, NOTIFICATIONS_SHOWN);
  const hidden = entries.length - NOTIFICATIONS_SHOWN;
  return (
    <section
      aria-label="Notifications"
      data-testid="overseer-notifications"
      className="flex flex-col"
    >
      <SectionLabel
        count={unreadCount > 0 ? unreadCount : undefined}
        className="h-6 px-2 pb-0.5"
        trailing={
          unreadCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={onMarkAllRead}
              data-testid="overseer-notifications-read-all"
            >
              Mark all read
            </Button>
          )
        }
      >
        Notifications
      </SectionLabel>
      <div role="list" className="flex flex-col">
        {shown.map((entry) => (
          <ListRow
            key={entry.id}
            role="listitem"
            data-testid="overseer-notification-row"
            data-unread={entry.read ? undefined : true}
            onClick={() => onOpen(entry)}
            leading={
              entry.read ? undefined : (
                <span
                  role="img"
                  aria-label="Unread"
                  data-slot="unread-dot"
                  className="bg-primary size-1.5 rounded-full"
                />
              )
            }
            // The subject (the task or question) leads; the generic kind
            // ("An agent needs your answer") is the tooltip, so two rows of
            // the same kind still read differently in a narrow column.
            title={
              <span
                title={entry.body === '' ? undefined : entry.title}
                className={entry.read ? 'text-muted-foreground' : undefined}
              >
                {entry.body === '' ? entry.title : entry.body}
              </span>
            }
            date={formatRelativeTimeFromIso(entry.ts)}
          />
        ))}
      </div>
      {hidden > 0 && (
        <div className="px-2">
          <CollapseBar
            label={all ? 'Show fewer' : `+${hidden} more`}
            collapsed={!all}
            onToggle={() => setAll(!all)}
          />
        </div>
      )}
    </section>
  );
}
