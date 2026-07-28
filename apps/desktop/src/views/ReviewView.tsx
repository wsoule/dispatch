import { ArrowLeft, Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AnnotatedDiff } from '../components/runs/AnnotatedDiff';
import { ReviewCommentsPanel } from '../components/runs/ReviewCommentsPanel';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { SectionLabel } from '../components/ui/SectionLabel';
import { StateDot } from '../components/ui/StateDot';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { deriveFeedState } from '../lib/feedState';
import {
  readViewed,
  toggleViewed,
  viewedSummary,
  writeViewed,
} from '../lib/reviewViewed';
import { parseUnifiedDiff } from '../lib/unifiedDiff';
import { cn } from '@/lib/utils';

interface ReviewViewProps {
  data: DispatchProjectData;
  onBack: () => void;
}

/**
 * Reviewing one run's work, full-page.
 *
 * Deliberately built from the same pieces the in-Runs review uses — `AnnotatedDiff` and
 * `ReviewCommentsPanel` — rather than reimplementing them. The difference is the frame, not the
 * behaviour: a file list with viewed ticks on the left, one file's diff at a time in the middle,
 * threads on the right. That framing is what the split view inside Runs cannot give you, because
 * there it is sharing the window with a run list and a transcript.
 *
 * Showing one file at a time is the point of the file list. A forty-file diff rendered as one
 * scroll is unreviewable, and "which have I actually read" is the question a reviewer is really
 * tracking.
 */
export function ReviewView({ data, onBack }: ReviewViewProps) {
  const run = data.runDetail?.meta;
  const runId = run?.id ?? '';

  const files = useMemo(
    () => (data.diff === undefined ? [] : parseUnifiedDiff(data.diff.patch)),
    [data.diff]
  );
  const paths = useMemo(() => files.map((f) => f.path), [files]);

  const [selected, setSelected] = useState<string | null>(null);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() =>
    readViewed(runId)
  );
  const [unviewedOnly, setUnviewedOnly] = useState(false);

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

  if (run === undefined) {
    return (
      <div className="flex h-full flex-col gap-3">
        <Header onBack={onBack} title="Review" />
        <p className="text-muted-foreground text-[12.5px]">
          Pick a run from the Control room to review it.
        </p>
      </div>
    );
  }

  const shown = unviewedOnly ? paths.filter((p) => !viewed.has(p)) : paths;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Header onBack={onBack} title={run.taskTitle} run={run} />

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_300px] gap-4 overflow-hidden">
        <div className="min-h-0 overflow-y-auto">
          <SectionLabel
            count={paths.length}
            trailing={
              <button
                type="button"
                onClick={() => setUnviewedOnly((v) => !v)}
                className="text-accent-foreground text-[11px]"
              >
                {unviewedOnly ? 'All files' : 'Unviewed only'}
              </button>
            }
          >
            Files changed
          </SectionLabel>
          <p className="dense-meta mt-1 mb-1.5">
            {viewedSummary(viewed, paths)}
          </p>

          <ul className="flex flex-col">
            {shown.map((path) => {
              const file = files.find((f) => f.path === path);
              const isViewed = viewed.has(path);
              const comments = commentsByFile.get(path) ?? 0;
              return (
                <li key={path}>
                  <button
                    type="button"
                    onClick={() => setSelected(path)}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors duration-150',
                      path === selected ? 'bg-accent/15' : 'hover:bg-muted/40'
                    )}
                  >
                    {/* Left-truncated so the filename survives on a deep path. */}
                    <span
                      dir="rtl"
                      className={cn(
                        'dense-meta min-w-0 flex-1 truncate text-left',
                        isViewed && 'opacity-50'
                      )}
                      title={path}
                    >
                      {path}
                    </span>
                    {comments > 0 && (
                      <span className="dense-meta text-accent-foreground">
                        {comments}
                      </span>
                    )}
                    <span className="dense-meta text-state-review">
                      +{file?.additions ?? 0}
                    </span>
                    <span className="dense-meta text-state-failed">
                      −{file?.deletions ?? 0}
                    </span>
                    <span
                      role="checkbox"
                      aria-checked={isViewed}
                      aria-label={`Mark ${path} viewed`}
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewed((v) => toggleViewed(v, path));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          setViewed((v) => toggleViewed(v, path));
                        }
                      }}
                      className={cn(
                        'grid size-3.5 shrink-0 place-items-center rounded-sm',
                        isViewed
                          ? 'bg-state-review text-background'
                          : 'shadow-hairline'
                      )}
                    >
                      {isViewed && <Check className="size-2.5" />}
                    </span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="text-muted-foreground px-2 py-2 text-[12px]">
                {paths.length === 0
                  ? 'No file changes recorded.'
                  : 'Every file has been viewed.'}
              </li>
            )}
          </ul>
        </div>

        <div className="min-h-0 overflow-auto">
          {data.diff !== undefined && selected !== null && (
            <AnnotatedDiff
              patch={data.diff.patch}
              only={selected}
              comments={data.reviewComments}
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
            onSendBack={data.handleSendBack}
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
        Control room
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
