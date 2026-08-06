import { cn } from '@/lib/utils';

/** Where one step of a multi-phase pipeline has got to. */
type StepStatus = 'passed' | 'active' | 'pending' | 'failed';

export interface Step {
  name: string;
  status: StepStatus;
}

const SEGMENT: Record<StepStatus, string> = {
  passed: 'bg-state-review',
  active: 'bg-state-working motion-safe:animate-pulse',
  failed: 'bg-state-failed',
  pending: 'bg-border',
};

interface StepStripProps {
  steps: Step[];
  className?: string;
}

/**
 * A row of equal segments showing how far a queued run has got through the merge pipeline.
 *
 * The segments are whatever phases the caller was actually told about — the strip never
 * invents a step count or advances one on a timer. A phase nobody has reported on renders as
 * pending, which is the truthful reading of "we have not heard anything about this yet".
 *
 * Segments are named for screen readers rather than being decorative, because the step name is
 * the information; the colors only rank them.
 */
export function StepStrip({ steps, className }: StepStripProps) {
  return (
    <ol className={cn('flex gap-1', className)}>
      {steps.map((step) => (
        <li
          key={step.name}
          title={`${step.name} — ${step.status}`}
          className={cn('h-0.5 flex-1 rounded-full', SEGMENT[step.status])}
        >
          <span className="sr-only">{`${step.name}: ${step.status}`}</span>
        </li>
      ))}
    </ol>
  );
}
