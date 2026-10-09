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
    // One line always: when the window is too narrow it scrolls sideways
    // rather than wrapping and pushing the list down.
    <div
      data-testid="tasks-strip"
      className="flex min-w-0 [scrollbar-width:none] flex-nowrap items-center gap-1.5 overflow-x-auto text-[12px] [&::-webkit-scrollbar]:hidden"
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
            className={cn('shrink-0 px-2', tone)}
          >
            {spec.label(n)}
          </Toggle>
        ) : (
          <Pill
            key={bucket}
            data-testid={`tasks-strip-${bucket}`}
            className={cn('text-muted-foreground shrink-0', tone)}
          >
            {spec.label(n)}
          </Pill>
        );
      })}
      <span className="text-muted-foreground shrink-0 px-1 whitespace-nowrap">
        ✓ {counts.landed}/{counts.total} landed
      </span>
    </div>
  );
}
