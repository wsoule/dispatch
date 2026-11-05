import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import styles from './spinner.module.css';
import type { SpinnerProps } from './types';

/**
 * An in-flight mark for agent or network work (the daemon starting, a
 * clone, a drafting run, a live tool call): a three-quarter arc over a
 * faint ring, in the surrounding text's colour or a `tone`'s (data-tone,
 * --tone). It turns only under prefers-reduced-motion: no-preference;
 * otherwise it is a still arc. `role="status"` named by `label`
 * ("Loading"); `label=""` hides it from assistive tech when a visible
 * label beside it already says what is happening. Never for a page load
 * (Skeleton) or a save (the new value shows at once).
 */
export function Spinner({
  size = 'sm',
  tone,
  label = 'Loading',
}: SpinnerProps): ReactNode {
  const hidden = label === '';
  return (
    <span
      role={hidden ? undefined : 'status'}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden ? 'true' : undefined}
      className={cx(styles.spinner, styles[size])}
      data-size={size}
      data-tone={tone}
    >
      <svg
        className={styles.svg}
        viewBox="0 0 16 16"
        focusable="false"
        aria-hidden="true"
      >
        <circle className={styles.track} cx="8" cy="8" r="6" />
        <path className={styles.arc} d="M8 2a6 6 0 1 1-6 6" />
      </svg>
    </span>
  );
}
