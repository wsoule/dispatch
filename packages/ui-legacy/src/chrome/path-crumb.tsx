import { cn } from '../lib/utils';

/** A slash-separated path with the leading directories dimmed to context. Mono, as
 * every file path is. */
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
        'flex min-w-0 flex-wrap items-center font-mono text-[12px]',
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
