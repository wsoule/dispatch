import { cn } from '@/lib/utils';

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
  return (
    <span
      className={cn('dense-meta flex shrink-0 items-center gap-1.5', className)}
    >
      {added > 0 && <span className="text-green">+{added}</span>}
      {removed > 0 && <span className="text-red">−{removed}</span>}
    </span>
  );
}
