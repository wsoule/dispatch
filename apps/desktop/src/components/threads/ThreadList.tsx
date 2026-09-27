import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Fragment, useEffect, useId, useState } from 'react';

import { resolveListKeyCommand } from '../../lib/keyboard';
import { formatShortDate } from '../../lib/taskDates';
import type { ThreadSummary } from '../../lib/threads';
import type { ThreadLookups } from '../../lib/threadSources';
import { participantLabel, threadTitle } from '../../lib/threadSources';
import { cn } from '@/lib/utils';
import { ListRow } from '@/ui/ai/list-row';
import { Pill } from '@/ui/ai/pill';

/** One run of rows; a named section is a group under its own header. */
interface ThreadListSection {
  key: string;
  /** The group's accessible name; without one the rows sit in the list directly. */
  name?: string;
  /** The group's header bar, drawn above its rows. */
  header?: ReactNode;
  summaries: readonly ThreadSummary[];
  /** Hides the rows, which the cursor then skips. */
  collapsed?: boolean;
}

export interface ThreadListProps {
  label: string;
  sections: readonly ThreadListSection[];
  /** The open thread. */
  selected: string | null;
  onSelect: (thread: string) => void;
  lookups: ThreadLookups;
}

// The id `by` steps from `from`, clamped to the ends; from nothing, the first or last.
function step(order: readonly string[], from: string | null, by: 1 | -1) {
  const at = from === null ? -1 : order.indexOf(from);
  if (at === -1) return by === 1 ? order[0] : order[order.length - 1];
  return order[Math.min(Math.max(at + by, 0), order.length - 1)];
}

/**
 * Thread rows as one listbox, like Inbox: a single tab stop whose cursor j/k
 * and the arrows move across every section, Enter opens and Escape clears.
 * A row shows the root's first line, who else is in it, unread count and
 * last activity.
 */
export function ThreadList({
  label,
  sections,
  selected,
  onSelect,
  lookups,
}: ThreadListProps) {
  const idPrefix = useId();
  const optionId = (thread: string) => `${idPrefix}-${thread}`;
  const [cursor, setCursor] = useState<string | null>(null);
  const order = sections.flatMap((section) =>
    section.collapsed === true ? [] : section.summaries.map((t) => t.thread)
  );
  // A cursor whose row is gone or collapsed points at nothing.
  const active = cursor !== null && order.includes(cursor) ? cursor : null;
  const activeId = active === null ? undefined : optionId(active);

  useEffect(() => {
    if (activeId !== undefined) {
      document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A group's collapse toggle keeps its own keys.
    if (event.target !== event.currentTarget) return;
    const command = resolveListKeyCommand(event, { isTyping: false });
    switch (command) {
      case 'list-down':
      case 'list-up': {
        event.preventDefault();
        const next = step(
          order,
          active ?? selected,
          command === 'list-down' ? 1 : -1
        );
        if (next !== undefined) setCursor(next);
        return;
      }
      case 'list-confirm':
      case 'list-open':
        if (active !== null) {
          event.preventDefault();
          onSelect(active);
        }
        return;
      case 'list-escape':
        if (active !== null) {
          event.preventDefault();
          setCursor(null);
        }
        return;
      default:
        return;
    }
  };

  // Options take no focus of their own, so the listbox takes their clicks and
  // keeps focus when one is clicked.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const option =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="option"]')
        : null;
    const thread = option?.dataset.thread;
    if (thread === undefined) return;
    setCursor(thread);
    onSelect(thread);
  };

  const rows = (summaries: readonly ThreadSummary[]) =>
    summaries.map((summary) => (
      <div
        key={summary.thread}
        id={optionId(summary.thread)}
        role="option"
        aria-selected={summary.thread === selected}
        data-thread={summary.thread}
      >
        <ListRow
          role="none"
          focused={summary.thread === active}
          className={cn(
            'cursor-pointer',
            summary.thread === selected &&
              'bg-surface-selected hover:bg-surface-selected'
          )}
          title={threadTitle(summary.root)}
          crumb={summary.participants
            .map((address) => participantLabel(address, lookups))
            .join(', ')}
          trailing={
            summary.unread > 0 ? (
              <Pill aria-label={`${summary.unread} unread`}>
                {summary.unread}
              </Pill>
            ) : undefined
          }
          date={formatShortDate(summary.last.createdAt)}
        />
      </div>
    ));

  return (
    <div
      role="listbox"
      aria-label={label}
      aria-activedescendant={activeId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={onClick}
      className="flex flex-col gap-1 outline-none"
    >
      {sections.map((section) => {
        const body = (
          <>
            {section.header}
            {section.collapsed !== true && rows(section.summaries)}
          </>
        );
        return section.name === undefined ? (
          <Fragment key={section.key}>{body}</Fragment>
        ) : (
          <div
            key={section.key}
            role="group"
            aria-label={section.name}
            className="flex flex-col"
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
