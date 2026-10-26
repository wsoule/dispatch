import { cn } from '../lib/utils';

// The pie's full arc — Linear's dash length for its r=2, 4-wide status pie. The status
// icons and the milestone glyph share it so a half-filled milestone matches a working task.
export const PIE_DASH = 12.189379495928398;
const PIE_DASHARRAY = `${PIE_DASH} ${PIE_DASH * 2}`;

/** The dashoffset that leaves `fraction` of the pie visible — 0 hides everything, 1 shows
 * the full arc. */
export function pieDashOffset(fraction: number): number {
  return PIE_DASH * (1 - fraction);
}

interface ProgressGlyphProps {
  /** How much of the pie is filled, 0..1. */
  fraction: number;
  className?: string;
}

/**
 * A progress glyph at 12px: the status icon's r=6 ring and r=2 pie, the pie filled to
 * `fraction` by the same dashoffset the status icons use — the `◔ 2/5` Linear draws in a
 * sub-issues header. Decorative; the caller labels the count next to it.
 */
export function ProgressGlyph({ fraction, className }: ProgressGlyphProps) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={cn('size-3 shrink-0 text-(--text-secondary)', className)}
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
