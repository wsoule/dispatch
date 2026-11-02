import { cx } from '@dispatch/ui';
import type { ReactNode } from 'react';

import styles from './Panel.module.css';

export interface PanelProps {
  /** The heading at the left of the panel's title row. */
  title: ReactNode;
  /** A quiet count after the title; omitted when undefined. */
  count?: number;
  /** Chips or quiet buttons at the right end of the title row. */
  actions?: ReactNode;
  /** True drops the body's padding, for a list whose rows pad themselves. */
  flush?: boolean;
  className?: string;
  children?: ReactNode;
}

/** A bordered box with a 36px title row (title, count, actions) over its body: the stand-in
    for the legacy chrome Panel + PanelHeader, for a section embedded in another surface. */
export function Panel({
  title,
  count,
  actions,
  flush = false,
  className,
  children,
}: PanelProps) {
  return (
    <section className={cx(styles.panel, className)}>
      <header className={styles.header}>
        <h3 className={styles.title}>{title}</h3>
        {count === undefined ? null : (
          <span className={styles.count}>{count}</span>
        )}
        {actions === undefined || actions === null ? null : (
          <div className={styles.actions}>{actions}</div>
        )}
      </header>
      <div className={cx(styles.body, flush && styles.flush)}>{children}</div>
    </section>
  );
}
