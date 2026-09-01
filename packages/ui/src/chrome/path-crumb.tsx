import { cn } from '../lib/utils';

/** A slash-separated path with the leading directories dimmed to context. */
export function PathCrumb({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const segments = path.split('/').filter(Boolean);
  return (
    <span
      className={cn(
        'dense-meta flex min-w-0 flex-wrap items-center',
        className
      )}
    >
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={`${segment}-${index}`} className="flex items-center">
            {index > 0 && <span className="text-muted-foreground px-1">/</span>}
            <span
              className={last ? 'text-foreground' : 'text-muted-foreground'}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </span>
  );
}
