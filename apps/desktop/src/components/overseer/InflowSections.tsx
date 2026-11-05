import type { DraftRecord } from '@dispatch/client';
import { Button, ListItem, Panel, SectionHeader } from '@dispatch/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { draftTrayViewModel } from '../../lib/draftTray';
import type { FeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { InboxEntry } from '../../lib/inbox';
import { StateMark } from '../status/StateMark';
import styles from './InflowSections.module.css';

/** How many notifications show before "+N more". */
const NOTIFICATIONS_SHOWN = 5;

// A failure body can carry a whole git log; the row shows its first line.
function firstLine(text: string): string {
  return text.split('\n', 1)[0].trim();
}

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

/** The 14px cross of a row's dismiss button. */
const dismissIcon = <X size={14} strokeWidth={1.8} aria-hidden="true" />;

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
    <section aria-label="Drafts" data-testid="overseer-drafts">
      <Panel as="div" flush>
        <SectionHeader
          as="h3"
          rule
          className={styles.head}
          name="Drafts"
          count={items.length}
        />
        <div role="list" className={styles.list}>
          {items.map((item) => {
            const draft = byId.get(item.id);
            return (
              <ListItem
                key={item.id}
                role="listitem"
                data-testid="overseer-draft-row"
                onClick={() => onOpen(item.id)}
                leading={<StateMark state={draftMark(draft)} />}
                title={item.label}
                crumb={draftCrumb(draft, item.taskCount)}
                // ListItem keeps a click or key in its trailing slot from
                // reaching the row, so dismissing never also opens the draft.
                trailing={
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label="Dismiss draft"
                    icon={dismissIcon}
                    onClick={() => onDismiss(item.id)}
                  />
                }
                date={item.elapsed}
              />
            );
          })}
        </div>
      </Panel>
    </section>
  );
}

/**
 * The notification history in Coming in: every run and merge transition the
 * app recorded, newest first, unread ones marked. A row opens what it is
 * about and its cross dismisses it; "Mark all read" clears the unread count,
 * "Clear all" empties the list and "Hide" takes it out of the side panel
 * (Settings → Notifications brings it back). Renders nothing while the
 * history is empty.
 */
export function NotificationsSection({
  entries,
  unreadCount,
  onMarkAllRead,
  onOpen,
  onDismiss,
  onClearAll,
  onHide,
}: {
  entries: readonly InboxEntry[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onOpen: (entry: InboxEntry) => void;
  onDismiss: (id: string) => void;
  onClearAll: () => void;
  onHide?: () => void;
}) {
  const [all, setAll] = useState(false);
  const listId = useId();
  if (entries.length === 0) return null;
  const shown = all ? entries : entries.slice(0, NOTIFICATIONS_SHOWN);
  const hidden = entries.length - NOTIFICATIONS_SHOWN;
  return (
    <section aria-label="Notifications" data-testid="overseer-notifications">
      <Panel as="div" flush>
        <SectionHeader
          as="h3"
          rule
          className={styles.head}
          name="Notifications"
          count={unreadCount > 0 ? unreadCount : undefined}
          actions={
            <>
              {unreadCount > 0 && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={onMarkAllRead}
                  data-testid="overseer-notifications-read-all"
                >
                  Mark all read
                </Button>
              )}
              <Button
                variant="quiet"
                size="sm"
                onClick={onClearAll}
                data-testid="overseer-notifications-clear-all"
              >
                Clear all
              </Button>
              {onHide !== undefined && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={onHide}
                  title="Hide notifications from the side panel. Settings → Notifications shows them again."
                  data-testid="overseer-notifications-hide"
                >
                  Hide
                </Button>
              )}
            </>
          }
        />
        <div id={listId} role="list" className={styles.list}>
          {shown.map((entry) => (
            <ListItem
              key={entry.id}
              role="listitem"
              data-testid="overseer-notification-row"
              // The accent dot, an sr-only "Unread" and data-unread on the row.
              unread={!entry.read}
              onClick={() => onOpen(entry)}
              // The subject (the task or question) leads; the generic kind
              // ("An agent needs your answer") and the full body are the
              // tooltip, so a multi-line failure log stays one row.
              title={
                <span
                  title={
                    entry.body === ''
                      ? undefined
                      : `${entry.title}\n${entry.body}`
                  }
                  className={entry.read ? styles.read : undefined}
                >
                  {entry.body === '' ? entry.title : firstLine(entry.body)}
                </span>
              }
              trailing={
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label="Dismiss notification"
                  data-testid="overseer-notification-dismiss"
                  icon={dismissIcon}
                  onClick={() => onDismiss(entry.id)}
                />
              }
              date={formatRelativeTimeFromIso(entry.ts)}
            />
          ))}
        </div>
        {hidden > 0 && (
          // A "show more" list: the first five stay put and the rest join
          // under them, so a quiet toggle under the list fits better than a
          // Disclosure (whose trigger sits above what it reveals).
          <div className={styles.more}>
            <Button
              variant="quiet"
              size="sm"
              aria-expanded={all}
              aria-controls={listId}
              onClick={() => setAll(!all)}
            >
              {all ? 'Show fewer' : `+${hidden} more`}
            </Button>
          </div>
        )}
      </Panel>
    </section>
  );
}
