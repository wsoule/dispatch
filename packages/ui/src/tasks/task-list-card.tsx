'use client';

import { ChevronRight } from 'lucide-react';

import { dataAttributes } from '../lib/data-attributes';
import { cx } from './class-names';
import { ListItem } from './list-item';
import { Panel } from './panel';
import styles from './task-list-card.module.css';
import type { TaskListCardProps } from './types';

/* A card of tasks someone proposed or sent out (the Overseer's plans and
   dispatches): a Panel with a banded head ("3 suggested tasks", a quiet
   "2 started" after it) over one ListItem per task, ruled off by
   --divider. A row's second line is its status ("Editing src/a.ts"); at
   its end sit the host's state dot and, when the row opens something, a
   chevron. A row that opens is a native button (ListItem as="button");
   one that does not is plain text. Started rows (`live`) keep the title
   in --text, the rest step down to --text-2, so what is moving reads
   first. No controls of its own: the whole row is the one action. */
export function TaskListCard(props: TaskListCardProps) {
  const { heading, note, items, className } = props;
  return (
    <Panel
      {...dataAttributes(props)}
      heading={heading}
      note={note}
      band
      flush
      as="div"
      className={cx(styles.card, className)}
    >
      <ul className={styles.list}>
        {items.map((item) => {
          const opens = item.onOpen !== undefined;
          return (
            <li
              {...dataAttributes(item)}
              key={item.id}
              className={styles.item}
              data-live={item.live === true ? 'true' : 'false'}
            >
              <ListItem
                as={opens ? 'button' : 'div'}
                onClick={item.onOpen}
                title={item.title}
                meta={item.status}
                date={
                  item.mark !== undefined || opens ? (
                    <span className={styles.end}>
                      <span className={styles.mark}>{item.mark}</span>
                      {opens ? (
                        <ChevronRight
                          className={styles.chevron}
                          size={14}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                  ) : undefined
                }
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
