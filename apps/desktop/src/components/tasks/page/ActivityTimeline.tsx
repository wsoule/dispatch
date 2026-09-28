import {
  Ban,
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  type LucideIcon,
  MessageSquareDiff,
  Play,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

import { formatRelativeTimeFromIso } from '../../../lib/format';
import { assigneeLabel } from '../../../lib/taskDisplay';
import type { TimelineItem, TimelineKind } from '../../../lib/taskTimeline';
import { usePeople } from '../../people/PeopleContext';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<TimelineKind, LucideIcon> = {
  dispatched: Play,
  finished: CircleCheck,
  failed: CircleX,
  merged: GitMerge,
  discarded: Trash2,
  pr: GitPullRequest,
  changes: MessageSquareDiff,
  stopped: Ban,
  note: StickyNote,
};

const KIND_TONE: Partial<Record<TimelineKind, string>> = {
  merged: 'text-status-done',
  finished: 'text-state-review',
  failed: 'text-state-failed',
  pr: 'text-state-review',
};

function Actor({ actor }: { actor: string | null }) {
  const people = usePeople();
  if (actor === null || actor === 'none') return null;
  const name = people.personFor(actor)?.name ?? assigneeLabel(actor);
  return <span className="text-(--text-secondary)">{name} </span>;
}

/**
 * The task's history as a rail of dated events, newest first: dispatches, finishes,
 * merges, PRs, requested changes, notes — each with its glyph, who did it and when. The
 * rail variant shows the latest few with a `Show all`; the summary shows everything.
 */
export function ActivityTimeline({
  items,
  initial,
}: {
  items: TimelineItem[];
  /** How many to show before `Show all`; omitted shows every item. */
  initial?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown =
    initial === undefined || expanded ? items : items.slice(0, initial);
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground font-book px-2 text-[12px]">
        Nothing has happened yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      <ol data-slot="activity-timeline" className="flex flex-col">
        {shown.map((item, i) => {
          const Icon = KIND_ICON[item.kind];
          const last = i === shown.length - 1;
          return (
            <li
              key={`${item.at ?? ''}-${i}`}
              data-kind={item.kind}
              className="relative flex gap-2 pb-2.5 pl-2"
            >
              {/* The rail between events. */}
              {!last && (
                <span
                  aria-hidden
                  className="bg-border absolute top-5 bottom-0 left-[15px] w-px"
                />
              )}
              <span
                className={cn(
                  'bg-surface-panel relative z-10 flex size-4 shrink-0 translate-y-0.5 items-center justify-center',
                  KIND_TONE[item.kind] ?? 'text-muted-foreground'
                )}
              >
                <Icon aria-hidden className="size-3.5" />
              </span>
              <p className="text-muted-foreground font-book min-w-0 flex-1 text-[12px] leading-5 break-words">
                <Actor actor={item.actor} />
                {item.text}
                {item.at !== null && (
                  <span className="whitespace-nowrap">
                    {' '}
                    · {formatRelativeTimeFromIso(item.at)}
                  </span>
                )}
              </p>
            </li>
          );
        })}
      </ol>
      {initial !== undefined && items.length > initial && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-muted-foreground rounded-control focus-visible:ring-ring ml-2 h-6 self-start px-1 text-[12px] font-medium outline-none hover:text-(--text-secondary) focus-visible:ring-2"
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
