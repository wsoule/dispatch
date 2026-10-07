import { presetForBucket, type TasksPreset } from '../../lib/tasksPresets';
import type { TaskBucket, TaskStatusCounts } from '../../lib/taskStatus';
import { cn } from '@/lib/utils';
import { Pill } from '@/ui/ai/pill';
import { Toggle } from '@/ui/toggle';

// Each bucket's chip: urgent ones tinted; one with a preset toggles it, the rest are labels.
const CHIP: Record<TaskBucket, { label: (n: number) => string; tone: string }> =
  {
    'need-you': {
      label: (n) => `● ${n} ${n === 1 ? 'task needs' : 'tasks need'} you`,
      tone: 'bg-(--state-waiting-surface) text-(--state-waiting-fg)',
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
export function TasksStrip({
  counts,
  preset,
  onPreset,
}: {
  counts: TaskStatusCounts;
  preset: TasksPreset;
  onPreset: (preset: TasksPreset) => void;
}) {
  return (
    <div
      data-testid="tasks-strip"
      className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px]"
    >
      {ORDER.map((bucket) => {
        const n = counts.buckets[bucket];
        const spec = CHIP[bucket];
        const chipPreset = presetForBucket(bucket);
        const active = chipPreset !== null && chipPreset === preset;
        // A zero still shows (nothing appears or vanishes), but quietly.
        const tone = n === 0 ? 'opacity-60' : spec.tone;
        return chipPreset !== null ? (
          <Toggle
            key={bucket}
            variant="outline"
            size="sm"
            data-testid={`tasks-strip-${bucket}`}
            pressed={active}
            onPressedChange={() => onPreset(active ? 'all' : chipPreset)}
            className={cn('px-2', tone)}
          >
            {spec.label(n)}
          </Toggle>
        ) : (
          <Pill
            key={bucket}
            data-testid={`tasks-strip-${bucket}`}
            className={cn('text-muted-foreground', tone)}
          >
            {spec.label(n)}
          </Pill>
        );
      })}
      <span className="text-muted-foreground px-1 whitespace-nowrap">
        ✓ {counts.landed}/{counts.total} landed
      </span>
    </div>
  );
}
