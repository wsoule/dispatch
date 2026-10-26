import { cx } from './class-names';
import styles from './task-glyphs.module.css';
import type { TaskPriority, TaskStateKind } from './types';

/* Issue-state glyphs in the Gr8r/Linear shapes, each in its workflow
   colour (--st-*, docs/architecture.md §8.2): triage, backlog and canceled
   grey (dashed for triage and backlog, struck for canceled), todo the
   neutral ring, in progress the blue half disc, done the green disc with a
   tick. Circles for issues so they never read as the milestone status
   diamonds. Decorative only (aria-hidden): the state's name is always
   printed beside the glyph, in neutral text. */
export function StateGlyph({
  kind,
  size = 14,
}: {
  kind: TaskStateKind;
  size?: number;
}) {
  return (
    <svg
      className={cx(styles.glyph, styles[kind])}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      {kind === 'completed' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.3"
            className={styles.check}
            fill="none"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={
            kind === 'triage' || kind === 'backlog' ? '1.9 2.1' : undefined
          }
        />
      )}
      {kind === 'started' ? (
        <path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" />
      ) : null}
      {kind === 'canceled' ? (
        <line
          x1="3.2"
          y1="10.8"
          x2="10.8"
          y2="3.2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      ) : null}
    </svg>
  );
}

// Bars lit per Linear priority (0 none … 1 urgent … 4 low).
const LIT: Record<TaskPriority, number> = { 0: 0, 1: 4, 2: 3, 3: 2, 4: 1 };
const BAR_HEIGHTS = [4, 6.5, 9, 11.5];

/* Priority in Gr8r's shapes: urgent is a red rounded square with a "!",
   no priority three short dashes, and high / medium / low lit bars in the
   secondary ink over ghost bars. Only urgent is coloured. Decorative only:
   the priority label is printed beside it. */
export function PriorityGlyph({
  priority,
  size = 14,
}: {
  priority: TaskPriority;
  size?: number;
}) {
  const lit = LIT[priority];
  return (
    <svg
      className={cx(styles.glyph, priority === 1 ? styles.urgent : undefined)}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      data-priority={priority}
    >
      {priority === 1 ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path
            d="M7 3.8v4.1"
            className={styles.bang}
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="7" cy="10.2" r="0.95" className={styles.bangDot} />
        </>
      ) : priority === 0 ? (
        [2.5, 6, 9.5].map((x) => (
          <rect
            key={x}
            x={x - 1.25}
            y="6.25"
            width="2.5"
            height="1.5"
            rx="0.75"
            className={styles.none}
          />
        ))
      ) : (
        BAR_HEIGHTS.map((h, i) => (
          <rect
            key={h}
            x={1 + i * 3.25}
            y={12.5 - h}
            width="2.25"
            height={h}
            rx="0.75"
            className={i < lit ? styles.lit : styles.ghost}
          />
        ))
      )}
    </svg>
  );
}
