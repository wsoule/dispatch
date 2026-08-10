import { cn } from '@/lib/utils';
import { Progress } from '@/ui/progress';

interface ProgressTrackProps {
  /**
   * Completion from 0 to 1, or `null` for indeterminate.
   *
   * `null` is not a fallback to reach for casually — it renders a moving stripe that says
   * "working, no estimate". Use it wherever the honest answer is that we don't know how far
   * along something is. An invented fraction is worse than no fraction: a bar that advances on
   * a timer looks like measurement and isn't.
   */
  value: number | null;
  className?: string;
  /** Describes what is progressing, for screen readers. */
  label: string;
}

/** The thin continuous bar under a working row and in the run-detail sidebar. */
export function ProgressTrack({ value, className, label }: ProgressTrackProps) {
  const indeterminate = value === null;
  const pct = indeterminate
    ? 100
    : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    // Progress forwards `value` to its Radix root, so aria-valuemin/-max/-valuenow
    // are already correct on their own — except `pct` is a fake 100 in the
    // indeterminate case (to drive the pulse animation), which would otherwise leak
    // out as a real "100%" value/valuetext. Override both to undefined there.
    <Progress
      value={pct}
      aria-label={label}
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuetext={indeterminate ? undefined : `${pct}%`}
      className={cn(
        'bg-border h-0.5 w-full overflow-hidden rounded-none',
        '[&>[data-slot=progress-indicator]]:bg-state-working [&>[data-slot=progress-indicator]]:transition-none',
        indeterminate &&
          '[&>[data-slot=progress-indicator]]:motion-safe:animate-pulse',
        className
      )}
    />
  );
}
