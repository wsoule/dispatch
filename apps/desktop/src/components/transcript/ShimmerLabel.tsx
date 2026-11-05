import type { ReactNode } from 'react';

import styles from './transcript.module.css';

/**
 * In-progress words that shimmer: a soft light sweep runs across the text while an agent is
 * working on it (a live run's outcome on Settings › Runs, an active session's title on
 * Usage). The sweep runs only for people who have not asked for less motion, and forced
 * colours drop it; both get the plain words. `data-shimmer` marks it for tests and hosts,
 * since CSS-module class names are not stable hooks.
 */
export function ShimmerLabel({ children }: { children: ReactNode }) {
  return (
    <span className={styles.shimmer} data-shimmer="">
      {children}
    </span>
  );
}
