'use client';

import { type ReactNode, useId, useState } from 'react';

import { Link } from '../lib/link';
import { cx } from '../tasks/class-names';
import { DEFAULT_TASK_LABELS, isExternalHref } from './shared';
import styles from './task-activity-list.module.css';
import type { TaskActivityItem, TaskActivityListProps } from './types';

function ActivityLabel({
  item,
  newTabLabel,
}: {
  item: TaskActivityItem;
  newTabLabel: string;
}): ReactNode {
  if (item.href === undefined) return item.label;
  const external = isExternalHref(item.href);
  return (
    <Link
      href={item.href}
      className={styles.link}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
    >
      {item.label}
      {external ? <span className="srOnly"> ({newTabLabel})</span> : null}
    </Link>
  );
}

/**
 * The task's history as Gr8r's activity lines: an 8px round mark coloured
 * by the item's tone (data-tone --tone: success green, info blue, warning
 * amber, danger red, accent something new; a hollow grey ring for muted
 * noise; the quiet text step by default), what happened with a sentence
 * of context under it, and the date on the right. The label takes the
 * tone's text colour when it needs action (accent, warning, danger). Items
 * render in the order given (hosts pass newest first). With `limit`, the
 * rest hide behind a "Show all N" button.
 */
export function TaskActivityList({
  items,
  label = DEFAULT_TASK_LABELS.activity,
  emptyLabel = DEFAULT_TASK_LABELS.noActivity,
  limit,
  showAllLabel = DEFAULT_TASK_LABELS.showAll,
  showFewerLabel = DEFAULT_TASK_LABELS.showFewer,
  newTabLabel = DEFAULT_TASK_LABELS.opensInNewTab,
}: TaskActivityListProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (items.length === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }
  const limited = limit !== undefined && items.length > limit;
  const shown = limited && !expanded ? items.slice(0, limit) : items;
  return (
    <div>
      <ol id={listId} className={styles.list} aria-label={label}>
        {shown.map((item) => {
          const tone = item.tone ?? 'default';
          return (
            <li
              key={item.id}
              className={cx(styles.item, styles[tone])}
              data-tone={tone}
            >
              {item.dateTime !== undefined ? (
                <time className={styles.at} dateTime={item.dateTime}>
                  {item.at}
                </time>
              ) : (
                <span className={styles.at}>{item.at}</span>
              )}
              <span className={styles.mark} aria-hidden="true" />
              <div className={styles.main}>
                <p className={styles.label} dir="auto">
                  <ActivityLabel item={item} newTabLabel={newTabLabel} />
                </p>
                {item.detail !== undefined &&
                item.detail !== null &&
                item.detail !== '' ? (
                  <p className={styles.detail} dir="auto">
                    {item.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {limited ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? showFewerLabel : `${showAllLabel} ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}
