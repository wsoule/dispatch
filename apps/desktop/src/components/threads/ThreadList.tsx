import { formatShortDate } from '../../lib/taskDates';
import type { ThreadSummary } from '../../lib/threads';
import type { ThreadLookups } from '../../lib/threadSources';
import { participantLabel, threadTitle } from '../../lib/threadSources';
import { ListRow } from '@/ui/ai/list-row';
import { Pill } from '@/ui/ai/pill';

export interface ThreadListProps {
  summaries: readonly ThreadSummary[];
  selected: string | null;
  onSelect: (thread: string) => void;
  lookups: ThreadLookups;
}

/** Thread rows: the root's first line, who else is in it, unread count and last activity. */
export function ThreadList({
  summaries,
  selected,
  onSelect,
  lookups,
}: ThreadListProps) {
  return (
    <div className="flex flex-col">
      {summaries.map((summary) => (
        <ListRow
          key={summary.thread}
          role="button"
          aria-current={summary.thread === selected ? 'true' : undefined}
          focused={summary.thread === selected}
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
          onClick={() => onSelect(summary.thread)}
        />
      ))}
    </div>
  );
}
