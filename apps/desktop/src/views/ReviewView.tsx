import { ArrowLeft, Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PierreReviewDiff } from '../components/runs/PierreReviewDiff';
import { ReviewCasePanel } from '../components/runs/ReviewCasePanel';
import { ReviewFileTree } from '../components/runs/ReviewFileTree';
import { buildReviewQueue, ReviewQueue } from '../components/runs/ReviewQueue';
import { ReviewThreadIndex } from '../components/runs/ReviewThreadIndex';
import { ReviewVerdictBar } from '../components/runs/ReviewVerdictBar';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  useEpicLedger,
  useProjectLedger,
  useTaskFindings,
} from '../hooks/useOrchestration';
import { deriveFeedState } from '../lib/feedState';
import { countOpenFindings } from '../lib/findings';
import { normalizeDiffFilePath } from '../lib/pierreTree';
import { openFindingsByFile } from '../lib/reviewAttention';
import { caseWarnings, summarizeCase } from '../lib/reviewCase';
import { readPanelOpen, writePanelOpen } from '../lib/reviewPanels';
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
  // Which side regions are showing. Persisted, so a reviewer who works with the diff full-width
  // is not asked to collapse the same two panels on every review.
  const [filesOpen, setFilesOpen] = useState(() => readPanelOpen('files'));
  const [threadsOpen, setThreadsOpen] = useState(() =>
    readPanelOpen('threads')
  );
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
  useEffect(() => writePanelOpen('files', filesOpen), [filesOpen]);
  useEffect(() => writePanelOpen('threads', threadsOpen), [threadsOpen]);

  // `selected === null` is the case panel, which is where a review opens: the agent's own
  // account of what it checked is the thing to read before file 1 of 10. Only correct the
  // selection when its file has left the diff underneath.
  useEffect(() => {
    if (selected !== null && !paths.includes(selected)) setSelected(null);
  }, [paths, selected]);

  const commentsByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of data.reviewComments) {
      if (c.resolved) continue;
      map.set(c.file, (map.get(c.file) ?? 0) + 1);
    }
    return map;
  }, [data.reviewComments]);

  // What the agent review found. `useTaskFindings` already returns `data ?? []`, so this is
  // always an array — an empty one means no review has run, never "clean".
  const { findings } = useTaskFindings(data.client, data.port, run?.taskId);
  const findingsByFile = useMemo(
    () => openFindingsByFile(findings),
    [findings]
  );

  // Decisions and hazards this run's task filed via `record_decision`. Both ledgers are read
  // because a task's entries land under its epic when it has one (`meta.parent`) and in the
  // project ledger when it does not.
  const task = useMemo(
    () => data.tasks.find((t) => t.meta.id === run?.taskId),
    [data.tasks, run]
  );
  const { entries: epicEntries } = useEpicLedger(
    data.client,
    data.port,
    task?.meta.parent ?? undefined
  );
  const { entries: projectEntries } = useProjectLedger(
    data.client,
    data.port,
    run !== undefined
  );
  const decisions = useMemo(
    () =>
      [...epicEntries, ...projectEntries].filter(
        (e) => e.sourceTaskId === run?.taskId
      ),
    [epicEntries, projectEntries, run]
  );

  // What approving would wave through: the agent's own flagged problems, plus anything its
  // reviewer raised that nobody has ruled on.
  const verdictWarnings = useMemo(() => {
    const summary = summarizeCase(
      data.runDetail?.evidence ?? [],
      data.runDetail?.mutations ?? []
    );
    const openFindings = countOpenFindings(findings).open;
    return [
      ...caseWarnings(summary),
      ...(openFindings > 0
        ? [`${openFindings} open finding${openFindings === 1 ? '' : 's'}`]
        : []),
    ];
  }, [data.runDetail, findings]);

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
      <Header
        onBack={onBack}
        title={run.taskTitle}
        run={run}
        filesOpen={filesOpen}
        onToggleFiles={() => setFilesOpen((v) => !v)}
        threadsOpen={threadsOpen}
        onToggleThreads={() => setThreadsOpen((v) => !v)}
        threadCount={data.reviewComments.length}
      />

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* `overflow-hidden`, not `-auto`: the list scrolls itself internally (its header and
            viewed summary stay pinned above it), so this only needs to bound the track —
            a second scrollbar here would just be redundant. */}
        {filesOpen && (
          <div className="flex min-h-0 w-56 shrink-0 flex-col overflow-hidden">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className={cn(
                'mb-1 flex shrink-0 items-center gap-1.5 rounded px-3 py-1 text-left text-[12px]',
                selected === null ? 'bg-accent/15' : 'hover:bg-muted/60'
              )}
            >
              <StateDot state="review" pulse={false} />
              The case
            </button>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ReviewFileTree
                files={data.diff?.files ?? []}
                onSelect={setSelected}
                viewed={viewed}
                commentsByFile={commentsByFile}
                findingsByFile={findingsByFile}
                unviewedOnly={unviewedOnly}
                onToggleUnviewedOnly={() => setUnviewedOnly((v) => !v)}
              />
            </div>
          </div>
        )}

        {/* A flex column, not a plain `min-h-0` box: `CodeView` needs a real, unambiguous height
            rather than a percentage resolved through an ancestor's stretch, which a nested
            container-then-percentage chain can (and did, in some engines) collapse to zero.
            `flex-1` on `CodeView` itself sizes it directly off this container's resolved
            height instead. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected === null && (
            <ReviewCasePanel
              evidence={data.runDetail?.evidence ?? []}
              mutations={data.runDetail?.mutations ?? []}
              findings={findings}
              decisions={decisions}
              onStartAiReview={handleStartAiReview}
            />
          )}
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

        {threadsOpen && (
          <div className="min-h-0 w-72 shrink-0 overflow-y-auto">
            <ReviewThreadIndex
              comments={data.reviewComments}
              onResolve={data.handleResolveReviewComment}
              onReply={data.handleReplyReviewComment}
              onJumpTo={(c) =>
                setJumpTo({ file: c.file, line: c.line, nonce: Date.now() })
              }
            />
          </div>
        )}
      </div>

      <ReviewVerdictBar
        layout="bar"
        comments={data.reviewComments}
        onSubmit={data.handleSubmitReview}
        onStartAiReview={handleStartAiReview}
        extraWarnings={verdictWarnings}
      />
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

/**
 * Two rows, not three, and the title at a size that does not wrap: this sits above a diff that
 * wants every pixel of height, so the back link shares a row with the title and the run's
 * identity shares one with the panel toggles.
 */
function Header({
  onBack,
  title,
  run,
  filesOpen,
  onToggleFiles,
  threadsOpen,
  onToggleThreads,
  threadCount,
}: {
  onBack: () => void;
  title: string;
  run?: {
    id: string;
    branch: string;
    model?: string;
    turns?: number;
    costUsd?: number;
  };
  filesOpen: boolean;
  onToggleFiles: () => void;
  threadsOpen: boolean;
  onToggleThreads: () => void;
  threadCount: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1.5 text-[11.5px]"
        >
          <ArrowLeft className="size-3" />
          {/* Closing a review returns to the review queue now that Review has
              one — it used to go back to the Control room, and kept saying so. */}
          All reviews
        </button>
        {run !== undefined && <StateDot state="review" pulse={false} />}
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">
          {title}
        </h1>
      </div>
      {run !== undefined && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="dense-meta">{run.branch}</span>
          {run.model !== undefined && (
            <span className="dense-meta">{run.model}</span>
          )}
          {run.turns !== undefined && (
            <span className="dense-meta">{run.turns} turns</span>
          )}
          {run.costUsd !== undefined && (
            <span className="dense-meta">${run.costUsd.toFixed(2)}</span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onToggleFiles}
            aria-pressed={filesOpen}
            className="text-accent-foreground text-[11px]"
          >
            {filesOpen ? 'Hide files' : 'Show files'}
          </button>
          <button
            type="button"
            onClick={onToggleThreads}
            aria-pressed={threadsOpen}
            className="text-accent-foreground text-[11px]"
          >
            {threadsOpen ? 'Hide threads' : `Threads (${threadCount})`}
          </button>
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
