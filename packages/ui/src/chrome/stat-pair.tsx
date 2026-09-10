import { cn } from '../lib/utils';

/** Added/removed line counts, tabular so digits stay aligned down a column. */
export function StatPair({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  // Both sides zero means no diff to report; an empty span would still take gap
  // space in the flex row that holds it.
  if (added <= 0 && removed <= 0) return null;
  return (
    <span
      className={cn('dense-meta flex shrink-0 items-center gap-1.5', className)}
    >
      {added > 0 && <span className="text-green">+{added}</span>}
      {removed > 0 && <span className="text-red">−{removed}</span>}
    </span>
  );
}
