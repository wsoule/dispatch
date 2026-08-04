import type { RepoPr, RunMeta } from '@dispatch/client';
import { GitPullRequest, GitPullRequestArrow } from 'lucide-react';

import { reviewTargetKey } from '../../lib/reviewTarget';
import type { ReviewTarget } from '../../lib/reviewTarget';
import { PrChecksPill, REVIEW_VERDICT, StatusPill } from './PrStatusPills';
import { cn } from '@/lib/utils';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

export interface ReviewQueueItem {
  /** What this row opens — a local run's diff, or a GitHub PR. */
  target: ReviewTarget;
  /** What the row shows: the task title for a run, the PR title otherwise. */
  title: string;
  /** True when this one is waiting on GitHub rather than on a local diff. */
  isPr: boolean;
  /** Sort key, newest first. */
  updatedAt: string;
  /** Present for a run-backed row — turns/cost and the send-back path. */
  run?: RunMeta;
  /** Present for any row with GitHub status to render. */
  pr?: RepoPr;
}

interface ReviewQueueProps {
  items: ReviewQueueItem[];
  selected: ReviewTarget | null;
  onSelect: (target: ReviewTarget) => void;
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
  selected,
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
                key={reviewTargetKey(item.target)}
                item={item}
                selected={
                  selected !== null &&
                  reviewTargetKey(selected) === reviewTargetKey(item.target)
                }
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
                key={reviewTargetKey(item.target)}
                item={item}
                selected={
                  selected !== null &&
                  reviewTargetKey(selected) === reviewTargetKey(item.target)
                }
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
  onSelect: (target: ReviewTarget) => void;
  compact: boolean;
}) {
  const { run, pr, isPr } = item;
  const Icon = isPr ? GitPullRequest : GitPullRequestArrow;
  const verdict =
    pr?.reviewDecision === 'APPROVED'
      ? REVIEW_VERDICT.APPROVED
      : pr?.reviewDecision === 'CHANGES_REQUESTED'
        ? REVIEW_VERDICT.CHANGES_REQUESTED
        : undefined;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.target)}
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
      <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
      {!compact && pr !== undefined && <PrChecksPill checks={pr.checks} />}
      {!compact && verdict !== undefined && (
        <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
      )}
      {!compact && pr?.mergeable === 'CONFLICTING' && (
        <StatusPill tone="red">Conflicts</StatusPill>
      )}
      {!compact && run?.turns !== undefined && (
        <span className="dense-meta shrink-0">{run.turns} turns</span>
      )}
      {!compact && run?.costUsd !== undefined && (
        <span className="dense-meta shrink-0">${run.costUsd.toFixed(2)}</span>
      )}
    </button>
  );
}

/**
 * Runs awaiting review plus every open repo PR, newest first. A
 * dispatch-opened PR arrives via both sources; the run-backed row
 * wins, since only it reaches send-back.
 *
 * Execute runs only: a review or verify agent's own RunMeta is finished
 * and never gets `reviewedAt`, so it would sit here forever under the
 * title of the work it reviewed. Absent `kind` still means execute.
 */
export function buildReviewQueue(
  runs: RunMeta[],
  repoPrs: RepoPr[] = []
): ReviewQueueItem[] {
  const prByUrl = new Map(repoPrs.map((pr) => [pr.url, pr]));
  const items: ReviewQueueItem[] = [];
  const claimedUrls = new Set<string>();

  for (const run of runs) {
    if ((run.kind ?? 'execute') !== 'execute') continue;
    if (run.archivedAt !== undefined) continue;
    const isPr = run.prUrl !== undefined;
    if (!isPr && !(run.state === 'finished' && run.reviewedAt === undefined)) {
      continue;
    }
    if (run.prUrl !== undefined) claimedUrls.add(run.prUrl);
    items.push({
      target: { kind: 'run', runId: run.id },
      title: run.taskTitle,
      isPr,
      updatedAt: run.updatedAt,
      run,
      ...(run.prUrl !== undefined && prByUrl.has(run.prUrl)
        ? { pr: prByUrl.get(run.prUrl) }
        : {}),
    });
  }

  for (const pr of repoPrs) {
    if (claimedUrls.has(pr.url)) continue;
    items.push({
      target: { kind: 'pr', number: pr.number },
      title: pr.title,
      isPr: true,
      updatedAt: pr.updatedAt,
      pr,
    });
  }

  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
