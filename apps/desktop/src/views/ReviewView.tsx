import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PierreReviewDiff } from '../components/runs/PierreReviewDiff';
import { PrReviewPanel } from '../components/runs/PrReviewPanel';
import { ReviewCasePanel } from '../components/runs/ReviewCasePanel';
import { ReviewFileTree } from '../components/runs/ReviewFileTree';
import { buildReviewQueue, ReviewQueue } from '../components/runs/ReviewQueue';
import { ReviewThreadIndex } from '../components/runs/ReviewThreadIndex';
import { ReviewVerdictBar } from '../components/runs/ReviewVerdictBar';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { repoPrsKey } from '../hooks/useDispatchProject';
import {
  useEpicLedger,
  useProjectLedger,
  useTaskFindings,
} from '../hooks/useOrchestration';
import { useRepoPrDetail } from '../hooks/useRepoPrDetail';
import { deriveFeedState } from '../lib/feedState';
import { countOpenFindings } from '../lib/findings';
import { normalizeDiffFilePath } from '../lib/pierreTree';
import { openFindingsByFile } from '../lib/reviewAttention';
import { caseWarnings, summarizeCase } from '../lib/reviewCase';
import { readPanelOpen, writePanelOpen } from '../lib/reviewPanels';
import type { ReviewTarget } from '../lib/reviewTarget';
import { reviewTargetKey } from '../lib/reviewTarget';
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
}

// How often the open-PR list is re-fetched while this page is on screen.
const REPO_PRS_POLL_MS = 60_000;

/**
 * Reviewing one run's work — or one pull request's — full-page.
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
 *
 * A PR gets that same frame, its diff fetched from GitHub rather than read out
 * of a worktree, and the same line-comment composer: a note written on a PR is
 * staged locally and then published to GitHub as part of one review when the
 * rail's panel submits a verdict. That panel opens by default on a PR (its own
 * `review` panel key), since it is the only place to approve one and the only
 * place from which a staged note reaches GitHub.
 */
export function ReviewView({
  data,
  onBack,
  selectedRunId,
  onSelectRun,
}: ReviewViewProps) {
  const queryClient = useQueryClient();
  const queue = useMemo(
    () => buildReviewQueue(data.runs, data.repoPrs ?? []),
    [data.runs, data.repoPrs]
  );

  // A repo PR has no run for nav's `activeRunId` to point at, so its selection
  // lives here — and wins over the run nav holds, being the later choice.
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  const isPrTarget = selectedPrNumber !== null;
  const selectedTarget: ReviewTarget | null =
    selectedPrNumber !== null
      ? { kind: 'pr', number: selectedPrNumber }
      : selectedRunId !== null
        ? { kind: 'run', runId: selectedRunId }
        : null;
  const targetKey =
    selectedTarget === null ? null : reviewTargetKey(selectedTarget);

  // No event announces a PR moving on GitHub, so triage needs a poll. Driven
  // from here, not the query, so it stops when this page does.
  useEffect(() => {
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: repoPrsKey(data.port) });
    }, REPO_PRS_POLL_MS);
    return () => clearInterval(id);
  }, [queryClient, data.port]);

  // A PR that has left the open list (merged or closed by someone else) has
  // nothing left to review. `null` is "not loaded yet", not "none open".
  useEffect(() => {
    if (selectedPrNumber === null || data.repoPrs === null) return;
    if (!data.repoPrs.some((pr) => pr.number === selectedPrNumber)) {
      setSelectedPrNumber(null);
    }
  }, [data.repoPrs, selectedPrNumber]);

  const repoPr = useRepoPrDetail(data.client, data.port, selectedPrNumber);

  // A PR has no run behind it, so the run-scoped panels below (the case, its
  // findings, its decisions) must not inherit whichever run nav still holds.
  const run = isPrTarget ? undefined : data.runDetail?.meta;
  const runId = run?.id ?? '';
  const selectedItem = useMemo(
    () => queue.find((i) => reviewTargetKey(i.target) === targetKey),
    [queue, targetKey]
  );

  // A PR's diff comes from GitHub, a run's from its worktree — the frame below
  // is identical either way, which is the whole point of the unified surface.
  const diff = isPrTarget ? repoPr.prDiff : data.diff;

  // Same shape either way — a run's threads come off its local store, a PR's
  // off the GitHub mirror — so every consumer below is target-agnostic.
  const reviewComments = isPrTarget
    ? repoPr.reviewComments
    : data.reviewComments;

  // Writes follow the open target too: the run handlers are
  // useDispatchProject's, keyed by the run nav holds; the PR handlers are
  // useRepoPrDetail's, which hit /api/prs/:number/comments instead.
  const handleAddComment = isPrTarget
    ? repoPr.handleAddReviewComment
    : data.handleAddReviewComment;
  const handleResolveComment = isPrTarget
    ? repoPr.handleResolveReviewComment
    : data.handleResolveReviewComment;
  const handleReplyComment = isPrTarget
    ? repoPr.handleReplyReviewComment
    : data.handleReplyReviewComment;
  // What the composer and thread copy should say a note does: reach the agent
  // when the review is submitted, or publish onto the PR on GitHub.
  const destination = isPrTarget ? 'github' : 'agent';

  const paths = useMemo(
    () => (diff?.files ?? []).map((f) => normalizeDiffFilePath(f.path)),
    [diff]
  );

  // Viewed ticks are stored per target. A run keeps its bare run id as the key,
  // so ticks saved before PRs joined this surface still load.
  const viewedKey =
    selectedPrNumber !== null
      ? reviewTargetKey({ kind: 'pr', number: selectedPrNumber })
      : runId;

  const [selected, setSelected] = useState<string | null>(null);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() =>
    readViewed(viewedKey)
  );
  const [unviewedOnly, setUnviewedOnly] = useState(false);
  // Which side regions are showing. Persisted, so a reviewer who works with the diff full-width
  // is not asked to collapse the same two panels on every review.
  const [filesOpen, setFilesOpen] = useState(() => readPanelOpen('files'));
  const [threadsOpen, setThreadsOpen] = useState(() =>
    readPanelOpen('threads')
  );
  // The PR rail is its own persisted panel, not the thread list's: a run
  // review's `threads: false` default would otherwise leave a PR with no
  // Approve, no Request changes and no Comment anywhere on screen.
  const [prRailOpen, setPrRailOpen] = useState(() => readPanelOpen('review'));
  // Which thread the diff should scroll to. Carries a nonce so clicking the same thread twice
  // still jumps — a value-equal object would not re-fire the effect.
  const [jumpTo, setJumpTo] = useState<{
    file: string;
    line: number;
    nonce: number;
  } | null>(null);

  // Re-read when the target changes, so opening a different review does not
  // inherit the last one's ticks.
  useEffect(() => setViewed(readViewed(viewedKey)), [viewedKey]);
  useEffect(() => {
    if (viewedKey !== '') writeViewed(viewedKey, viewed);
  }, [viewedKey, viewed]);
  useEffect(() => writePanelOpen('files', filesOpen), [filesOpen]);
  useEffect(() => writePanelOpen('threads', threadsOpen), [threadsOpen]);
  useEffect(() => writePanelOpen('review', prRailOpen), [prRailOpen]);

  // `selected === null` is the case panel, which is where a review opens: the agent's own
  // account of what it checked is the thing to read before file 1 of 10. Only correct the
  // selection when its file has left the diff underneath.
  useEffect(() => {
    if (selected !== null && !paths.includes(selected)) setSelected(null);
  }, [paths, selected]);

  // Notes written here but not yet on GitHub. Every verdict button publishes
  // them, Comment included — so the panel needs the count to know whether
  // Comment is a review submit or a plain conversation comment.
  const stagedNoteCount = useMemo(
    () => (isPrTarget ? reviewComments.filter((c) => c.pending).length : 0),
    [isPrTarget, reviewComments]
  );

  const commentsByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of reviewComments) {
      if (c.resolved) continue;
      map.set(c.file, (map.get(c.file) ?? 0) + 1);
    }
    return map;
  }, [reviewComments]);

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

  // A run opens through nav (other surfaces jump to it), a PR through this
  // view's own state. Each drops the other, so both can never claim the screen.
  const handleSelectTarget = useCallback(
    (target: ReviewTarget) => {
      if (target.kind === 'pr') {
        setSelectedPrNumber(target.number);
        return;
      }
      setSelectedPrNumber(null);
      onSelectRun(target.runId);
    },
    [onSelectRun]
  );

  const handleBack = useCallback(() => {
    setSelectedPrNumber(null);
    onBack();
  }, [onBack]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // Nothing open: the queue IS the screen. Everything waiting on a human, in
  // one place, instead of a sentence telling you to go and find it elsewhere.
  if (selectedTarget === null || (!isPrTarget && run === undefined)) {
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
            selected={selectedTarget}
            onSelect={handleSelectTarget}
          />
          {/* The merge queue lives here because approving is what puts things
              in it — as its own destination it split one flow across two
              screens you had to remember to check. */}
          <LandingView data={data} onOpenRun={onSelectRun} />
        </div>
      </div>
    );
  }

  // The GitHub review layer, for a repo PR off its number-keyed detail and for
  // a dispatch-opened run off the run-keyed one. Both post straight to GitHub.
  //
  // It owns the PR's status header too — one source, refreshed by every action
  // here, rather than a second copy in the page header off the 60s repo poll.
  const prPanel = isPrTarget ? (
    <PrReviewPanel
      detail={repoPr.prDetail}
      loading={repoPr.prDetailLoading}
      error={repoPr.prDetailError}
      onReview={repoPr.handleReview}
      onComment={repoPr.handleComment}
      stagedNotes={stagedNoteCount}
    />
  ) : run !== undefined && run.prUrl !== undefined ? (
    <PrReviewPanel
      detail={data.prDetail}
      loading={data.prDetailLoading}
      error={data.prDetailError}
      onReview={(event, body) => data.handlePrReview(run.id, event, body)}
      onComment={(body) => data.handlePrComment(run.id, body)}
    />
  ) : null;

  // With a PR to act on the rail is a review surface, not a comment list, so
  // it gets its own default-open panel state and says so on the toggle.
  const hasPrPanel = prPanel !== null;
  const railOpen = hasPrPanel ? prRailOpen : threadsOpen;
  const toggleRail = () => {
    if (hasPrPanel) setPrRailOpen((v) => !v);
    else setThreadsOpen((v) => !v);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Header
        onBack={handleBack}
        title={
          selectedItem?.title ??
          run?.taskTitle ??
          repoPr.prDetail?.status.title ??
          'Review'
        }
        run={run}
        filesOpen={filesOpen}
        onToggleFiles={() => setFilesOpen((v) => !v)}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        railLabel={hasPrPanel ? 'Review' : 'Threads'}
        railCount={
          isPrTarget
            ? (repoPr.prDetail?.conversation.length ?? 0)
            : reviewComments.length
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* `overflow-hidden`, not `-auto`: the list scrolls itself internally (its header and
            viewed summary stay pinned above it), so this only needs to bound the track —
            a second scrollbar here would just be redundant. */}
        {filesOpen && (
          <div className="flex min-h-0 w-56 shrink-0 flex-col overflow-hidden">
            {/* The case is the agent's account of its own work. A PR has no
                agent behind it, so there is nothing to open here. */}
            {!isPrTarget && (
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
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              <ReviewFileTree
                files={diff?.files ?? []}
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
          {!isPrTarget && selected === null && (
            <>
              {/* An empty file tree beside the case reads as "this run
                  changed nothing" when the diff simply failed to load. */}
              {data.diffError !== null && (
                <p className="text-destructive p-4 text-[12.5px]">
                  Couldn&rsquo;t load this run&rsquo;s diff: {data.diffError}
                </p>
              )}
              {data.diffError === null && data.diffLoading && (
                <p className="text-muted-foreground p-4 text-[12.5px]">
                  Loading the diff…
                </p>
              )}
              <ReviewCasePanel
                evidence={data.runDetail?.evidence ?? []}
                mutations={data.runDetail?.mutations ?? []}
                findings={findings}
                decisions={decisions}
                onStartAiReview={handleStartAiReview}
              />
            </>
          )}
          {/* A failed fetch must not read as "this PR changes nothing" — an
              empty file tree beside cheerful copy is the worse failure. */}
          {isPrTarget && selected === null && repoPr.prDiffError !== null && (
            <p className="text-destructive p-4 text-[12.5px]">
              Couldn&rsquo;t load this pull request&rsquo;s diff from GitHub:{' '}
              {repoPr.prDiffError}
            </p>
          )}
          {isPrTarget && selected === null && repoPr.prDiffError === null && (
            <p className="text-muted-foreground p-4 text-[12.5px]">
              {repoPr.prDiffLoading
                ? 'Fetching the diff from GitHub…'
                : 'Pick a file to start reviewing.'}
            </p>
          )}
          {diff !== undefined && selected !== null && (
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
                patch={diff.patch}
                only={selected}
                comments={reviewComments}
                findings={findingsByFile.get(selected) ?? []}
                viewed={viewed}
                scrollTo={jumpTo}
                onAdd={handleAddComment}
                onResolve={handleResolveComment}
                onReply={handleReplyComment}
                destination={destination}
              />
            </>
          )}
        </div>

        {railOpen && (
          <div className="flex min-h-0 w-72 shrink-0 flex-col gap-3 overflow-y-auto">
            {prPanel}
            {/* An empty thread list must not read as "nobody commented" when
                the GitHub pull is what failed. */}
            {isPrTarget && repoPr.reviewCommentsError !== null && (
              <p className="text-destructive text-[12.5px]">
                Couldn&rsquo;t load this pull request&rsquo;s threads:{' '}
                {repoPr.reviewCommentsError}
              </p>
            )}
            <ReviewThreadIndex
              comments={reviewComments}
              onResolve={handleResolveComment}
              onReply={handleReplyComment}
              onJumpTo={(c) =>
                setJumpTo({ file: c.file, line: c.line, nonce: Date.now() })
              }
              destination={destination}
            />
            {/* Says plainly what this list is and is not: notes here are
                staged until a verdict publishes them, and a reply written on
                github.com never comes back into a thread (the mirror drops
                in-reply payloads) — it lands in the conversation above. */}
            {isPrTarget && (
              <p className="text-muted-foreground text-[11.5px]">
                Notes stay staged until you comment, approve or request changes
                above, then publish to GitHub as one review. Replies written on
                github.com show in the conversation, not in these threads.
              </p>
            )}
          </div>
        )}
      </div>

      {/* A PR is approved on GitHub, from the panel in the rail — the local
          merge/discard verdict has no meaning for one. */}
      {!isPrTarget && (
        <ReviewVerdictBar
          layout="bar"
          comments={reviewComments}
          onSubmit={data.handleSubmitReview}
          onStartAiReview={handleStartAiReview}
          extraWarnings={verdictWarnings}
        />
      )}
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
  railOpen,
  onToggleRail,
  railLabel,
  railCount,
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
  railOpen: boolean;
  onToggleRail: () => void;
  /** What the right rail is here: "Review" with a PR in it, else "Threads". */
  railLabel: string;
  railCount: number;
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
        <StateDot state="review" pulse={false} />
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">
          {title}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {run !== undefined && (
          <>
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
          </>
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
          onClick={onToggleRail}
          aria-pressed={railOpen}
          className="text-accent-foreground text-[11px]"
        >
          {railOpen
            ? `Hide ${railLabel.toLowerCase()}`
            : `${railLabel} (${railCount})`}
        </button>
      </div>
    </div>
  );
}

/** Kept exported for the nav badge — how many runs are waiting on a review right now. */
export function countAwaitingReview(
  runs: Parameters<typeof deriveFeedState>[0][]
): number {
  return runs.filter((r) => deriveFeedState(r) === 'review').length;
}
