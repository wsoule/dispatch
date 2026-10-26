import { type ReactNode, useId } from 'react';

import { cx } from '../tasks/class-names';
import { Heading } from './shared';
import styles from './task-section.module.css';
import type { TaskDetailSectionProps } from './types';

/* A titled block of the task view (Description, Blocked by, Activity, or a
   host's own section): a sentence-case heading with an optional count and
   a right-aligned note or control, over its content. Exported so a host's
   extra sections read as part of the same sheet. */
export function TaskDetailSection({
  title,
  headingLevel = 3,
  count,
  meta,
  hideTitle = false,
  id,
  className,
  children,
}: TaskDetailSectionProps): ReactNode {
  const headingId = useId();
  return (
    <section
      id={id}
      className={cx(styles.section, className)}
      aria-labelledby={headingId}
    >
      <div className={cx(styles.head, hideTitle ? 'srOnly' : undefined)}>
        <Heading level={headingLevel} id={headingId} className={styles.title}>
          {title}
          {count !== undefined ? (
            <span className={styles.count}>
              <span className="srOnly">, </span>
              {count}
            </span>
          ) : null}
        </Heading>
        {meta !== undefined && meta !== null ? (
          <div className={styles.meta}>{meta}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
