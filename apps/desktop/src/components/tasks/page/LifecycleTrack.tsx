import {
  FileDiff,
  FileText,
  Flag,
  type LucideIcon,
  SquareTerminal,
  Waypoints,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';

import type {
  LifecycleStage,
  StageProgress,
  TaskPageMode,
} from '../../../lib/taskPageMode';
import { cn } from '@/lib/utils';
import { useElapsed } from '@/ui/ai/use-elapsed';
import { focusRovingItem, nextRovingIndex } from '@/ui/lib/roving';

const MODE_ICON: Record<TaskPageMode, LucideIcon> = {
  spec: FileText,
  run: SquareTerminal,
  review: FileDiff,
  summary: Flag,
  plan: Waypoints,
};

// The bar under each stage: how far the task got through it. The current stage paints in
// the task's own status colour (set inline), so the track and the status glyph agree.
const BAR_CLASS: Record<StageProgress, string> = {
  done: 'bg-state-review',
  current: '',
  failed: 'bg-state-failed',
  pending: 'bg-border',
  skipped: 'border-t border-dashed border-border bg-transparent',
};

function LiveClock({ since }: { since: string }) {
  const started = Date.parse(since);
  const label = useElapsed(Number.isNaN(started) ? undefined : started);
  return <span className="tabular-nums">{label}</span>;
}

export interface LifecycleTrackProps {
  stages: LifecycleStage[];
  /** The mode the page is showing. */
  active: TaskPageMode;
  onSelect: (mode: TaskPageMode) => void;
  /** The task's status colour, for the current stage's bar. */
  statusColor: string;
  className?: string;
}

/**
 * The task page's mode tabs, drawn as the task's lifecycle: Spec → Run → Review →
 * Summary (Spec → Plan → Summary for a container). Each stage is a tab with a one-line
 * caption and a bar that says how far the task got through it — done, skipped, failed,
 * pending, or current in the status colour, pulsing while an agent is live. The tab being
 * viewed lifts; the bar keeps saying where the task really is when you look elsewhere.
 */
export function LifecycleTrack({
  stages,
  active,
  onSelect,
  statusColor,
  className,
}: LifecycleTrackProps) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = stages.findIndex((s) => s.mode === active);
    const next = nextRovingIndex(event.key, current, stages.length);
    if (next === null) return;
    event.preventDefault();
    const stage = stages[next];
    if (stage !== undefined) onSelect(stage.mode);
    focusRovingItem(event.currentTarget, '[role="tab"]', next);
  }
  return (
    <div
      role="tablist"
      aria-label="Task stages"
      data-slot="lifecycle-track"
      className={cn('flex gap-1', className)}
      onKeyDown={onKeyDown}
    >
      {stages.map((stage) => {
        const selected = stage.mode === active;
        const Icon = MODE_ICON[stage.mode];
        const current = stage.progress === 'current';
        return (
          <button
            key={stage.mode}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-mode={stage.mode}
            data-progress={stage.progress}
            onClick={() => onSelect(stage.mode)}
            className={cn(
              'group/stage rounded-control flex min-w-0 flex-1 flex-col gap-1 px-2.5 pt-1.5 pb-2 text-left transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'bg-surface-active' : 'hover:bg-surface-hover'
            )}
          >
            <span
              className={cn(
                'flex items-center gap-1.5 text-[12px] leading-4 font-medium',
                selected || current
                  ? 'text-foreground'
                  : 'text-(--text-secondary)'
              )}
            >
              <Icon
                aria-hidden
                className="size-3.5 shrink-0"
                style={current ? { color: statusColor } : undefined}
              />
              {stage.label}
            </span>
            <span className="text-muted-foreground font-book flex min-w-0 items-center gap-1 truncate text-[12px] leading-4">
              <span className="truncate">{stage.caption}</span>
              {stage.liveSince !== undefined && (
                <>
                  <span aria-hidden>·</span>
                  <LiveClock since={stage.liveSince} />
                </>
              )}
            </span>
            <span
              aria-hidden
              className={cn(
                'h-0.5 w-full rounded-full',
                BAR_CLASS[stage.progress],
                current &&
                  stage.liveSince !== undefined &&
                  'motion-safe:animate-pulse'
              )}
              style={current ? { backgroundColor: statusColor } : undefined}
            />
          </button>
        );
      })}
    </div>
  );
}
