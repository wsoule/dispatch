import { ArrowLeft, Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PierreReviewDiff } from '../components/runs/PierreReviewDiff';
import { ReviewCommentsPanel } from '../components/runs/ReviewCommentsPanel';
import { ReviewFileTree } from '../components/runs/ReviewFileTree';
import { buildReviewQueue, ReviewQueue } from '../components/runs/ReviewQueue';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { deriveFeedState } from '../lib/feedState';
import { normalizeDiffFilePath } from '../lib/pierreTree';
import { readViewed, toggleViewed, writeViewed } from '../lib/reviewViewed';
import { LandingView } from './LandingView';
import { cn } from '@/lib/utils';
import { MetaText } from '@/ui/chrome';
import { StateDot } from '@/ui/chrome/StateDot';

interface ReviewViewProps {
  data: DispatchProjectData;
  onBack: () => void;
  /** Which run is open. Null shows the queue, which is the screen's real home. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /** Renders a run whose diff lives on GitHub — Pull requests moved in here. */
  renderPr: (runId: string) => React.ReactNode;
}

/**
 * Reviewing one run's work, full-page.
 *
 * Deliberately built from the same pieces the in-Runs review uses — `PierreReviewDiff` and
 * `ReviewCommentsPanel` — rather than reimplementing them. The difference is the frame, not the
 * behaviour: a file list with viewed ticks on the left, one file's diff at a time in the middle,
 * threads on the right. That framing is what the split view inside Runs cannot give you, because
 * there it is sharing the window with a run list and a transcript.
 *
 * Showing one file at a time is the point of the file list. A forty-file diff rendered as one
 * scroll is unreviewable, and "which have I actually read" is the question a reviewer is really
 * tracking.
 */
export function ReviewView({
  data,
  onBack,
  selectedRunId,
  onSelectRun,
  renderPr,
}: ReviewViewProps) {
  const queue = useMemo(() => buildReviewQueue(data.runs), [data.runs]);
  const run = data.runDetail?.meta;
  const runId = run?.id ?? '';

  const paths = useMemo(
    () => (data.diff?.files ?? []).map((f) => normalizeDiffFilePath(f.path)),
    [data.diff]
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() =>
    readViewed(runId)
  );
  const [unviewedOnly, setUnviewedOnly] = useState(false);
  // Which thread the diff should scroll to. Carries a nonce so clicking the same thread twice
  // still jumps — a value-equal object would not re-fire the effect.
  const [jumpTo, setJumpTo] = useState<{
    file: string;
    line: number;
    nonce: number;
  } | null>(null);

  // Re-read when the run changes, so opening a different review does not inherit the last
  // one's ticks.
  useEffect(() => setViewed(readViewed(runId)), [runId]);
  useEffect(() => {
    if (runId !== '') writeViewed(runId, viewed);
  }, [runId, viewed]);

  // Land on the first file, and follow along if the diff changes underneath.
  useEffect(() => {
    if (selected === null || !paths.includes(selected)) {
      setSelected(paths[0] ?? null);
    }
  }, [paths, selected]);

  const commentsByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of data.reviewComments) {
      if (c.resolved) continue;
      map.set(c.file, (map.get(c.file) ?? 0) + 1);
    }
    return map;
  }, [data.reviewComments]);

  // Dispatches a review agent over this run's diff — base/head/runId all come from the run
  // already open here, never invented or asked of the reviewer. `startReview` resolves once the
  // run is accepted; its findings land on the task asynchronously (see `FindingStore`), not in
  // this panel.
  const handleStartAiReview = useCallback(async () => {
    if (data.client === null || run === undefined) {
      throw new Error('The task daemon is not ready yet.');
    }
    await data.client.startReview(run.taskId, {
      base: run.baseBranch,
      head: run.branch,
      runId: run.id,
    });
  }, [data.client, run]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // No run open: the queue IS the screen. Everything waiting on a human, in
  // one place, instead of a sentence telling you to go and find it elsewhere.
  if (selectedRunId === null || run === undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="view-topbar-title">Review</h1>
          <span className="text-muted-foreground text-[12px]">
            Local diffs and open pull requests.
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
          <ReviewQueue
            items={queue}
            selectedRunId={selectedRunId}
            onSelect={onSelectRun}
          />
          {/* The merge queue lives here because approving is what puts things
              in it — as its own destination it split one flow across two
              screens you had to remember to check. */}
          <LandingView data={data} onOpenRun={onSelectRun} />
        </div>
      </div>
    );
  }

  // A PR's diff lives on GitHub, so it gets the PR surface rather than the
  // local file-tree review below.
  if (run.prUrl !== undefined) {
    return <>{renderPr(run.id)}</>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Header onBack={onBack} title={run.taskTitle} run={run} />

      <div className="grid min-h-0 flex-1 grid-cols-[190px_200px_minmax(0,1fr)_290px] gap-4 overflow-hidden">
        <div className="min-h-0 overflow-y-auto">
          <ReviewQueue
            items={queue}
            selectedRunId={selectedRunId}
            onSelect={onSelectRun}
            compact
          />
        </div>

        {/* `overflow-hidden`, not `-auto`: the list scrolls itself internally (its header and
            viewed summary stay pinned above it), so this only needs to bound the grid track —
            a second scrollbar here would just be redundant. */}
        <div className="min-h-0 overflow-hidden">
          <ReviewFileTree
            files={data.diff?.files ?? []}
            onSelect={setSelected}
            viewed={viewed}
            commentsByFile={commentsByFile}
            unviewedOnly={unviewedOnly}
            onToggleUnviewedOnly={() => setUnviewedOnly((v) => !v)}
          />
        </div>

        {/* A flex column, not a plain `min-h-0` box: `CodeView` needs a real, unambiguous height
            rather than a percentage resolved through this grid cell's stretch, which a nested
            grid-then-percentage chain can (and did, in some engines) collapse to zero. `flex-1`
            on `CodeView` itself below sizes it directly off this container's own resolved
            height instead. */}
        <div className="flex min-h-0 flex-col">
          {data.diff !== undefined && selected !== null && (
            <>
              <DiffPaneHeader
                path={selected}
                isViewed={viewed.has(selected)}
                onToggleViewed={() =>
                  setViewed((v) => toggleViewed(v, selected))
                }
                commentCount={commentsByFile.get(selected) ?? 0}
              />
              <PierreReviewDiff
                patch={data.diff.patch}
                only={selected}
                comments={data.reviewComments}
                viewed={viewed}
                scrollTo={jumpTo}
                onAdd={data.handleAddReviewComment}
                onResolve={data.handleResolveReviewComment}
                onReply={data.handleReplyReviewComment}
              />
            </>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto">
          <ReviewCommentsPanel
            comments={data.reviewComments}
            onResolve={data.handleResolveReviewComment}
            onReply={data.handleReplyReviewComment}
            onSubmit={data.handleSubmitReview}
            onJumpTo={(c) =>
              setJumpTo({ file: c.file, line: c.line, nonce: Date.now() })
            }
            onStartAiReview={handleStartAiReview}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Sits above the open file's diff: its path, unresolved-comment count, and viewed toggle — moved
 * here from a per-row strip beneath the file tree, since `FileTree` has no slot to host them.
 */
function DiffPaneHeader({
  path,
  isViewed,
  onToggleViewed,
  commentCount,
}: {
  path: string;
  isViewed: boolean;
  onToggleViewed: () => void;
  commentCount: number;
}) {
  return (
    <div className="border-border flex shrink-0 items-center gap-2 border-b px-1 pb-2">
      <span
        dir="rtl"
        title={path}
        className={cn(
          'dense-meta min-w-0 flex-1 truncate text-left',
          isViewed && 'opacity-50'
        )}
      >
        {path}
      </span>
      {commentCount > 0 && (
        <MetaText className="text-accent-foreground shrink-0">
          {commentCount}
        </MetaText>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={isViewed}
        aria-label={`Mark ${path} viewed`}
        onClick={onToggleViewed}
        className={cn(
          'grid size-3.5 shrink-0 place-items-center rounded-sm',
          isViewed ? 'bg-state-review text-background' : 'shadow-hairline'
        )}
      >
        {isViewed && <Check className="size-2.5" />}
      </button>
    </div>
  );
}

function Header({
  onBack,
  title,
  run,
}: {
  onBack: () => void;
  title: string;
  run?: { id: string; branch: string; turns?: number; costUsd?: number };
}) {
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-[11.5px]"
      >
        <ArrowLeft className="size-3" />
        {/* Closing a review returns to the review queue now that Review has
            one — it used to go back to the Control room, and kept saying so. */}
        All reviews
      </button>
      <div className="flex items-center gap-2">
        {run !== undefined && <StateDot state="review" pulse={false} />}
        <h1 className="view-topbar-title">{title}</h1>
      </div>
      {run !== undefined && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="dense-meta">{run.branch}</span>
          {run.turns !== undefined && (
            <span className="dense-meta">{run.turns} turns</span>
          )}
          {run.costUsd !== undefined && (
            <span className="dense-meta">${run.costUsd.toFixed(2)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Kept exported for the nav badge — how many runs are waiting on a review right now. */
export function countAwaitingReview(
  runs: Parameters<typeof deriveFeedState>[0][]
): number {
  return runs.filter((r) => deriveFeedState(r) === 'review').length;
}
