import { ShimmerLabel } from './shimmer';
import { useElapsed } from './use-elapsed';

export type LoadingStateProps = {
  label: string;
  startedAt?: number;
  variant?: 'grid' | 'orbit';
};

// Per-cell animation-delay stagger for the 3x3 pixel grid, ported from the Beautiful UI
// showcase's own hand-tuned sequence rather than an even 90ms*index ramp.
const GRID_DELAYS_MS = [90, 180, 270, 0, 90, 180, 90, 180, 270];

// Nine cells pulsing opacity on a stagger, reading as a busy pixel grid. `motion-reduce`
// drops the pulse to a static dim state so the primitive still communicates "loading"
// without motion.
function PixelGrid() {
  return (
    <span
      aria-hidden="true"
      className="grid grid-cols-[repeat(3,3px)] gap-[1.5px]"
    >
      {GRID_DELAYS_MS.map((delayMs, index) => (
        <span
          key={index}
          className="bg-foreground size-[3px] animate-[pixel-on_650ms_ease-in-out_infinite] rounded-[1px] opacity-15 motion-reduce:animate-none motion-reduce:opacity-40"
          style={{ animationDelay: `${delayMs}ms` }}
        />
      ))}
    </span>
  );
}

// Three dots that orbit together around a common center, reusing the same rotation
// keyframe as the rest of the app's spinners (`animate-spin`).
function DotsOrbit() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block size-3.5 animate-spin motion-reduce:animate-none"
    >
      <span className="bg-foreground absolute top-0 left-1/2 size-[3px] -translate-x-1/2 rounded-full" />
      <span className="bg-foreground absolute bottom-0 left-0 size-[3px] rounded-full opacity-70" />
      <span className="bg-foreground absolute right-0 bottom-0 size-[3px] rounded-full opacity-40" />
    </span>
  );
}

/** Loading indicator for long-running agent work: a pulsing pixel grid or orbiting dots,
 * a shimmering label, and a live elapsed-time readout. Matches the showcase's "Loading
 * State" primitive (pixel-grid loader, shimmer label, elapsed time). */
export function LoadingState({
  label,
  startedAt,
  variant = 'grid',
}: LoadingStateProps) {
  const elapsed = useElapsed(startedAt);

  return (
    <div className="flex w-fit items-center gap-2.5">
      {variant === 'grid' ? <PixelGrid /> : <DotsOrbit />}
      <ShimmerLabel className="text-[13px] font-medium">{label}</ShimmerLabel>
      <span className="text-muted-foreground font-mono text-[12px] tabular-nums">
        {elapsed}
      </span>
    </div>
  );
}
