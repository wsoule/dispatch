import { dataAttributes } from '../lib/data-attributes';
import { cx } from './class-names';
import styles from './progress-rule.module.css';
import type { ProgressRuleProps } from './types';

/* completed/scope as Gr8r's progress bar: a 4px rounded --surface-3 track
   with an accent fill and a quiet "3/7" receipt in tabular figures. Any
   tone but default paints the fill in the tone's hue (data-tone): danger
   overdue, warning behind pace, success complete, muted inactive; the
   receipt stays quiet text. Exposed as a progressbar with a sentence
   value ("3 of 7 done", or the host's valueText for a meter of something
   else, such as agent slots in use). The host's data-* hooks land on the
   root span. */
export function ProgressRule(props: ProgressRuleProps) {
  const {
    done,
    total,
    tone = 'default',
    label,
    'aria-label': ariaLabel = 'Progress',
    valueText,
  } = props;
  const safeTotal = Math.max(0, total);
  const safeDone = Math.min(Math.max(0, done), safeTotal);
  const ratio = safeTotal === 0 ? 0 : safeDone / safeTotal;
  const visible = label === undefined ? `${safeDone}/${safeTotal}` : label;

  return (
    <span
      {...dataAttributes(props)}
      className={cx(styles.wrap, tone === 'default' ? undefined : styles.toned)}
      data-tone={tone}
    >
      <span
        className={styles.track}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={safeDone}
        aria-valuetext={
          valueText === undefined || valueText === ''
            ? `${safeDone} of ${safeTotal} done`
            : valueText
        }
      >
        <span
          className={styles.fill}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </span>
      {visible !== null ? (
        <span className={styles.label} aria-hidden="true">
          {visible}
        </span>
      ) : null}
    </span>
  );
}
