import { Button, type UiTone } from '@dispatch/ui';
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
import styles from './ActivityTimeline.module.css';

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

// Each event's glyph colour, through the data-tone hook (the words always say what
// happened, so the hue is never the only cue): red for a failure; green for a run that
// succeeded or a pull request ready for review; blue for a run starting; amber for work
// waiting on the agent again (changes asked for); grey for the rest, landed work included
// (done keeps a neutral mark, never green beside a red failure).
const KIND_TONE: Record<TimelineKind, UiTone> = {
  dispatched: 'info',
  finished: 'success',
  failed: 'danger',
  merged: 'muted',
  discarded: 'muted',
  pr: 'success',
  changes: 'warning',
  stopped: 'muted',
  note: 'muted',
};

function Actor({ actor }: { actor: string | null }) {
  const people = usePeople();
  if (actor === null || actor === 'none') return null;
  const name = people.personFor(actor)?.name ?? assigneeLabel(actor);
  return <span className={styles.actor}>{name} </span>;
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
    return <p className={styles.empty}>Nothing has happened yet.</p>;
  }
  return (
    <div className={styles.root}>
      <ol data-slot="activity-timeline" className={styles.list}>
        {shown.map((item, i) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <li
              key={`${item.at ?? ''}-${i}`}
              data-kind={item.kind}
              className={styles.event}
            >
              <span className={styles.glyph} data-tone={KIND_TONE[item.kind]}>
                <Icon size={14} strokeWidth={1.8} aria-hidden />
              </span>
              <p className={styles.text}>
                <Actor actor={item.actor} />
                {item.text}
                {item.at !== null && (
                  <span className={styles.when}>
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
        <Button
          variant="quiet"
          size="sm"
          className={styles.more}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </Button>
      )}
    </div>
  );
}
