import type { RunMeta } from '@dispatch/client';
import { GitPullRequest, GitPullRequestArrow } from 'lucide-react';

import { SectionLabel } from '../ui/SectionLabel';
import { cn } from '@/lib/utils';

export interface ReviewQueueItem {
  run: RunMeta;
  /** True when this one is waiting on GitHub rather than on a local diff. */
  isPr: boolean;
}

interface ReviewQueueProps {
  items: ReviewQueueItem[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  /** Compact mode renders as a narrow rail beside an open review. */
  compact?: boolean;
}

/**
 * Everything waiting on a review, in one list.
 *
 * The Review screen used to open on "Pick a run from the Control room", which
 * made reviewing a thing you could only start somewhere else — the one screen
 * named after the job could not tell you the job existed. This is the queue
 * that fixes that, and it is also where Pull requests went: a PR is a run whose
 * diff happens to live on GitHub, so putting it in a separate top-level view
 * split one question ("what needs me to look at it?") across two places.
 */
export function ReviewQueue({
  items,
  selectedRunId,
  onSelect,
  compact = false,
}: ReviewQueueProps) {
  const local = items.filter((i) => !i.isPr);
  const prs = items.filter((i) => i.isPr);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-[12.5px]">
        Nothing is waiting on a review. Finished runs show up here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {local.length > 0 && (
        <section>
          <SectionLabel rule count={local.length}>
            Needs review
          </SectionLabel>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {local.map((item) => (
              <Row
                key={item.run.id}
                item={item}
                selected={item.run.id === selectedRunId}
                onSelect={onSelect}
                compact={compact}
              />
            ))}
          </div>
        </section>
      )}
      {prs.length > 0 && (
        <section>
          <SectionLabel rule count={prs.length}>
            Pull requests
          </SectionLabel>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {prs.map((item) => (
              <Row
                key={item.run.id}
                item={item}
                selected={item.run.id === selectedRunId}
                onSelect={onSelect}
                compact={compact}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({
  item,
  selected,
  onSelect,
  compact,
}: {
  item: ReviewQueueItem;
  selected: boolean;
  onSelect: (runId: string) => void;
  compact: boolean;
}) {
  const { run, isPr } = item;
  const Icon = isPr ? GitPullRequest : GitPullRequestArrow;
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors duration-150',
        selected ? 'border-border bg-accent' : 'hover:bg-muted/60'
      )}
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          isPr ? 'text-state-landing' : 'text-state-review'
        )}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {run.taskTitle}
      </span>
      {!compact && run.turns !== undefined && (
        <span className="dense-meta shrink-0">{run.turns} turns</span>
      )}
      {!compact && run.costUsd !== undefined && (
        <span className="dense-meta shrink-0">${run.costUsd.toFixed(2)}</span>
      )}
    </button>
  );
}

/**
 * The runs a human still has to look at: finished-but-unreviewed work, plus
 * anything with a PR still open. Sorted newest first so the queue reads like an
 * inbox rather than an archaeology dig.
 */
export function buildReviewQueue(runs: RunMeta[]): ReviewQueueItem[] {
  return runs
    .filter(
      (r) =>
        r.archivedAt === undefined &&
        (r.prUrl !== undefined ||
          (r.state === 'finished' && r.reviewedAt === undefined))
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((run) => ({ run, isPr: run.prUrl !== undefined }));
}
