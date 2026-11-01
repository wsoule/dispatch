import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import styles from './spinner.module.css';
import type { SpinnerProps } from './types';

/* A ring in the current colour for work in progress: a status with a
   label, decoration with label null; reduced motion slows it. */
export function Spinner({
  size = 'sm',
  label = 'Loading',
  className,
}: SpinnerProps): ReactNode {
  const ring = <span className={styles.ring} aria-hidden="true" />;
  if (label === null) {
    return (
      <span
        className={cx(styles.spinner, styles[size], className)}
        aria-hidden="true"
      >
        {ring}
      </span>
    );
  }
  return (
    <span role="status" className={cx(styles.spinner, styles[size], className)}>
      {ring}
      <span className="srOnly">{label}</span>
    </span>
  );
}
