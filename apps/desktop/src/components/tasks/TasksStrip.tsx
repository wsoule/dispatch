import type { TaskBucket, TaskStatusCounts } from '../../lib/taskStatus';
import { cn } from '@/lib/utils';

// Each bucket's chip: urgent ones tinted, resting ones outlined; a zero stays visible.
const CHIP: Record<TaskBucket, { label: (n: number) => string; tone: string }> =
  {
    'need-you': {
      label: (n) => `● ${n} ${n === 1 ? 'task needs' : 'tasks need'} you`,
      tone: 'bg-(--state-waiting-surface) text-(--state-waiting-fg) font-medium',
    },
    failed: {
      label: (n) => `✕ ${n} failed`,
      tone: 'bg-(--state-failed-surface) text-(--state-failed-fg)',
    },
    working: {
      label: (n) => `◐ ${n} working`,
      tone: 'bg-(--state-working-surface) text-(--state-working-fg)',
    },
    review: {
      label: (n) => `◇ ${n} review`,
      tone: 'bg-(--state-review-surface) text-(--state-review-fg)',
    },
    landing: { label: (n) => `${n} landing`, tone: '' },
    ready: { label: (n) => `${n} ready`, tone: '' },
    draft: { label: (n) => `${n} draft`, tone: '' },
    blocked: { label: (n) => `${n} blocked`, tone: '' },
  };

const ORDER: readonly TaskBucket[] = [
  'need-you',
  'failed',
  'working',
  'review',
  'landing',
  'ready',
  'draft',
  'blocked',
];

/** The Tasks strip: every open task in one bucket, plus landed over total. */
export function TasksStrip({ counts }: { counts: TaskStatusCounts }) {
  return (
    <div
      data-testid="tasks-strip"
      className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px]"
    >
      {ORDER.map((bucket) => {
        const n = counts.buckets[bucket];
        const spec = CHIP[bucket];
        return (
          <span
            key={bucket}
            data-testid={`tasks-strip-${bucket}`}
            className={cn(
              'rounded-pill px-2 py-px whitespace-nowrap',
              spec.tone === '' || n === 0
                ? 'border-border-chip text-muted-foreground border-[0.5px]'
                : spec.tone
            )}
          >
            {spec.label(n)}
          </span>
        );
      })}
      <span className="text-muted-foreground px-1 whitespace-nowrap">
        ✓ {counts.landed}/{counts.total} landed
      </span>
    </div>
  );
}
