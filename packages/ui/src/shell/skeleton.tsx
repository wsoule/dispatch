import type { CSSProperties, ReactNode } from 'react';

import { cx } from './render';
import styles from './skeleton.module.css';
import type {
  SkeletonBlockProps,
  SkeletonProps,
  SkeletonRowsProps,
  SkeletonTextProps,
} from './types';

// Loading placeholders (Gr8r's skeletons): soft shimmering bars and blocks
// that hold the page's real layout. Widths are deterministic so server and
// client markup agree.

/** One shimmering bar. Decorative: wrap groups in a labelled container. */
export function Skeleton({
  width = '100%',
  height = 10,
  className,
}: SkeletonProps): ReactNode {
  const style: CSSProperties = { width, height };
  return (
    <span
      aria-hidden="true"
      className={cx(styles.bar, className)}
      style={style}
    />
  );
}

/** The accessible wrapper every skeleton group uses: one polite "Loading"
    for assistive tech, the shapes hidden from it. */
function Busy({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="srOnly">{label}</span>
      {children}
    </div>
  );
}

/** A few lines of running text; the last line is shorter, like prose. */
export function SkeletonText({
  lines = 3,
  label = 'Loading',
}: SkeletonTextProps): ReactNode {
  return (
    <Busy label={label} className={styles.text}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          height={9}
          width={i === lines - 1 ? '58%' : `${92 - ((i * 7) % 14)}%`}
        />
      ))}
    </Busy>
  );
}

/** A solid block for a chart, card or panel. */
export function SkeletonBlock({
  height = 120,
  label = 'Loading',
}: SkeletonBlockProps): ReactNode {
  return (
    <Busy label={label} className={styles.blockWrap}>
      <Skeleton height={height} className={styles.block} />
    </Busy>
  );
}

/** Register rows in the grouped-list rhythm: status mark, title, chip and
    a short trailing value per 40px row. */
export function SkeletonRows({
  rows = 6,
  label = 'Loading',
}: SkeletonRowsProps): ReactNode {
  return (
    <Busy label={label} className={styles.rows}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row} aria-hidden="true">
          <Skeleton width={13} height={13} className={styles.round} />
          <Skeleton
            width={`${38 + ((i * 13) % 30)}%`}
            height={10}
            className={styles.line}
          />
          <span className={styles.spacer} />
          <Skeleton width={54} height={16} className={styles.chip} />
          <Skeleton width={38} height={10} className={styles.chip} />
        </div>
      ))}
    </Busy>
  );
}
