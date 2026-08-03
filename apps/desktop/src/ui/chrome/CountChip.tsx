import { cn } from '@/lib/utils';

interface CountChipProps {
  count: number;
  /** Render nothing at zero. On by default: a nav rail full of "0"s is noise, not information. */
  hideZero?: boolean;
  className?: string;
}

/**
 * A bare mono count, used for sidebar badges and group totals.
 *
 * Deliberately not a filled pill. These sit next to a label that already carries the meaning,
 * so a background would make a count read as a status of its own — and a rail of eight tinted
 * pills reads as eight alerts.
 */
export function CountChip({
  count,
  hideZero = true,
  className,
}: CountChipProps) {
  if (hideZero && count === 0) return null;
  return <span className={cn('dense-meta', className)}>{count}</span>;
}
