import { isValidElement, type ReactNode } from 'react';

import { Link } from '../lib/link';
import type { ShellCrumb } from '../shell/types';
import { cx } from '../tasks/class-names';
import styles from './task-crumbs.module.css';
import type { TaskCrumbsProps, TaskDetailProps } from './types';

/** Tells crumb data ([{ label, href }]) from a ready node: both can be
    arrays, but only crumbs are plain objects with a string label. An empty
    list is not a trail (the key stands in). */
export function isCrumbList(
  value: TaskDetailProps['breadcrumb']
): value is readonly ShellCrumb[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        !isValidElement(item) &&
        typeof (item as { label?: unknown }).label === 'string'
    )
  );
}

/**
 * The header's trail ("Beacon search / Search v2 beta / ENG-24"): crumbs
 * become a labelled nav with links through the host's <Link>, the last one
 * marked as the current page (in the mono id voice when it is the task's
 * key); a ready node renders as given; with neither, the task key stands
 * alone. One line: when it runs out of room
 * only the earlier crumbs shrink (and step aside below 260px), so the
 * last one, usually the key, stays readable.
 */
export function TaskCrumbs({
  breadcrumb,
  taskKey,
  label,
}: TaskCrumbsProps): ReactNode {
  if (
    breadcrumb === undefined ||
    breadcrumb === null ||
    (Array.isArray(breadcrumb) && breadcrumb.length === 0)
  ) {
    return <span className={cx(styles.trail, styles.key)}>{taskKey}</span>;
  }
  if (!isCrumbList(breadcrumb)) {
    return <span className={styles.trail}>{breadcrumb as ReactNode}</span>;
  }
  const last = breadcrumb.length - 1;
  return (
    <nav aria-label={label} className={cx(styles.trail, styles.crumbs)}>
      <ol className={styles.list}>
        {breadcrumb.map((crumb, i) => (
          <li key={`${i}:${crumb.label}`} className={styles.item}>
            {i > 0 ? (
              <span className={styles.sep} aria-hidden="true">
                /
              </span>
            ) : null}
            {crumb.href !== undefined && i !== last ? (
              <Link
                href={crumb.href}
                className={cx(styles.label, styles.link)}
                title={crumb.label}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={cx(
                  styles.label,
                  i === last ? styles.current : undefined,
                  i === last && crumb.label === taskKey ? styles.key : undefined
                )}
                aria-current={i === last ? 'page' : undefined}
                title={crumb.label}
              >
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
