import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { PierreReviewDiff } from '../components/runs/PierreReviewDiff';
import { ReviewCommentsPanel } from '../components/runs/ReviewCommentsPanel';
import { ReviewFileTree } from '../components/runs/ReviewFileTree';
import { buildReviewQueue, ReviewQueue } from '../components/runs/ReviewQueue';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { StateDot } from '../components/ui/StateDot';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { deriveFeedState } from '../lib/feedState';
import { normalizeDiffFilePath } from '../lib/pierreTree';
import { readViewed, toggleViewed, writeViewed } from '../lib/reviewViewed';
import { LandingView } from './LandingView';

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

        <ReviewFileTree
          files={data.diff?.files ?? []}
          selected={selected}
          onSelect={setSelected}
          viewed={viewed}
          onToggleViewed={(path) => setViewed((v) => toggleViewed(v, path))}
          commentsByFile={commentsByFile}
          unviewedOnly={unviewedOnly}
          onToggleUnviewedOnly={() => setUnviewedOnly((v) => !v)}
        />

        <div className="min-h-0 overflow-auto">
          {data.diff !== undefined && selected !== null && (
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
          />
        </div>
      </div>
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
