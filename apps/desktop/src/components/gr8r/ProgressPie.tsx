import { cx } from './cx';
import styles from './ProgressPie.module.css';

// The pie's full arc: Linear's dash length for its r=2, 4-wide status pie. The status icons
// and the milestone glyph share it so a half-filled milestone matches a working task.
const PIE_DASH = 12.189379495928398;
const PIE_DASHARRAY = `${PIE_DASH} ${PIE_DASH * 2}`;

/** The dashoffset that leaves `fraction` of the pie visible: 0 hides it, 1 shows it all. */
function pieDashOffset(fraction: number): number {
  return PIE_DASH * (1 - fraction);
}

/** A 12px ring with a pie filled to `fraction` (the `◔ 2/5` beside a count). Decorative: the
    caller prints the count next to it. */
export function ProgressPie({
  fraction,
  className,
}: {
  /** How much of the pie is filled, 0..1. */
  fraction: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cx(styles.pie, className)}
    >
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle
        cx="7"
        cy="7"
        r="2"
        stroke="currentColor"
        strokeWidth="4"
        strokeDasharray={PIE_DASHARRAY}
        strokeDashoffset={pieDashOffset(fraction)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}
