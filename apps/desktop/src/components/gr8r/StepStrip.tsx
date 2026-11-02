import { cx } from '@dispatch/ui';

import styles from './StepStrip.module.css';

/** Where one step of a multi-phase pipeline has got to. */
type StepStatus = 'passed' | 'active' | 'pending' | 'failed';

export interface Step {
  name: string;
  status: StepStatus;
}

// A step's tone hook: passed and active in the info hue (active pulses), failed in danger,
// pending a plain grey track.
const TONE: Record<StepStatus, string> = {
  passed: 'success',
  active: 'info',
  failed: 'danger',
  pending: 'muted',
};

/**
 * A row of equal 2px segments, one per reported step (the waves of a fan-out). It never
 * invents a step or advances on a timer; each segment is named for screen readers, since the
 * name is the information and the colour only ranks it.
 */
export function StepStrip({
  steps,
  className,
}: {
  steps: readonly Step[];
  className?: string;
}) {
  return (
    <ol className={cx(styles.strip, className)}>
      {steps.map((step) => (
        <li
          key={step.name}
          title={`${step.name} · ${step.status}`}
          data-tone={TONE[step.status]}
          data-status={step.status}
          className={styles.step}
        >
          <span className="srOnly">{`${step.name}: ${step.status}`}</span>
        </li>
      ))}
    </ol>
  );
}
