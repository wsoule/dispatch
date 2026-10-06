import type { Finding } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, PanelLeftIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { PierreReviewDiff } from '../components/runs/PierreReviewDiff';
import { PrReviewPanel } from '../components/runs/PrReviewPanel';
import { ReviewFileTree } from '../components/runs/ReviewFileTree';
import { ReviewThreadIndex } from '../components/runs/ReviewThreadIndex';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import {
  TasksBackButton,
  TasksPageHeader,
} from '../components/tasks/TasksPageHeader';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { repoPrsKey } from '../hooks/useDispatchProject';
import { usePrFindings } from '../hooks/useOrchestration';
import { repoPrDetailKey, useRepoPrDetail } from '../hooks/useRepoPrDetail';
import { readPanelOpen, writePanelOpen } from '../lib/reviewPanels';
import { reviewTargetKey } from '../lib/reviewTarget';
import { readViewed, toggleViewed, writeViewed } from '../lib/reviewViewed';
import { IconButton } from '@/ui/ai/icon-button';
import { PageHeader, SidePanelIconButton } from '@/ui/ai/page-header';

interface PrReviewViewProps {
  data: DispatchProjectData;
  /** The active project's display name, the first crumb of the page header. */
  projectName?: string | null;
  /** Which repo pull request is open — `navReducer`'s `activePrNumber`. */
  prNumber: number;
  onBack: () => void;
  /** Two views: "‹ tasks" leads the header and the crumb starts at Pull requests. */
  tasksPage?: boolean;
}

// How often the open-PR list is re-fetched while this page is on screen.
const REPO_PRS_POLL_MS = 60_000;

/**
 * Reviewing one repo pull request, full-page.
 *
 * The same frame a run's diff gets in the task view — a file list with viewed
 * ticks on the left, the whole diff in one scroller in the middle, threads on
 * the right — with the diff fetched from GitHub rather than read out of a
 * worktree. Every file is on the page, so a review is a scroll, not a click
 * per file; the file list is how you jump, and "which have I actually read"
 * is answered by the viewed tick in each file's header, which collapses the
 * file once it is ticked.
 *
 * A note written here is staged locally and published to GitHub as part of one
 * review when the rail's panel submits a verdict. That panel is default-open
 * (its own `review` panel key), since it is the only place to approve a PR and
 * the only place from which a staged note reaches GitHub.
 */
export function PrReviewView({
  data,
  projectName,
  prNumber,
  onBack,
  tasksPage = false,
}: PrReviewViewProps) {
  const queryClient = useQueryClient();

  // No event announces a PR moving on GitHub, so triage needs a poll. Driven
  // from here, not the query, so it stops when this page does.
  useEffect(() => {
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: repoPrsKey(data.port) });
    }, REPO_PRS_POLL_MS);
    return () => clearInterval(id);
  }, [queryClient, data.port]);

  // A PR that has left the open list merged or closed while it was on screen.
  // The surface stays open — a reviewer holding staged notes has to be told
  // why they cannot send them, and closing it out from under them would take
  // the notes and the diff away too. Only the status is now wrong, so that is
  // what gets re-read. `null` is "not loaded yet", not "none open".
  useEffect(() => {
    if (data.repoPrs === null) return;
    if (data.repoPrs.some((pr) => pr.number === prNumber)) return;
    void queryClient.invalidateQueries({
      queryKey: repoPrDetailKey(data.client?.baseUrl, prNumber),
    });
  }, [data.repoPrs, data.client, queryClient, prNumber]);

  const repoPr = useRepoPrDetail(data.client, data.port, prNumber);

  // The open-PR row, not the detail: `isCrossRepository`/`headRepositoryOwner`
  // ride the one `GET /api/prs` call the inbox queue already makes, so the fork
  // gate costs nothing extra to render.
  const selectedRepoPr = useMemo(
    () => data.repoPrs?.find((pr) => pr.number === prNumber),
    [data.repoPrs, prNumber]
  );

  const diff = repoPr.prDiff;
  const reviewComments = repoPr.reviewComments;

  // Viewed ticks are stored per target, so a PR's ticks never collide with a
  // run's.
  const viewedKey = reviewTargetKey({ kind: 'pr', number: prNumber });

  const [viewed, setViewed] = useState<ReadonlySet<string>>(() =>
    readViewed(viewedKey)
  );
  const [unviewedOnly, setUnviewedOnly] = useState(false);
  // Which side regions are showing. Persisted, so a reviewer who works with the
  // diff full-width is not asked to collapse the same panel on every review.
  const [filesOpen, setFilesOpen] = useState(() => readPanelOpen('files'));
  // The PR rail is its own persisted panel, not the thread list's: a run
  // review's `threads: false` default would otherwise leave a PR with no
  // Approve, no Request changes and no Comment anywhere on screen.
  const [railOpen, setRailOpen] = useState(() => readPanelOpen('review'));
  // Where the diff should scroll: a thread's line, or the top of a file picked
  // in the tree. Carries a nonce so clicking the same thread or file twice
  // still jumps — a value-equal object would not re-fire the effect.
  const [jumpTo, setJumpTo] = useState<{
    file: string;
    line?: number;
    nonce: number;
  } | null>(null);

  // Re-read when the PR changes, so opening a different one does not inherit
  // the last one's ticks.
  useEffect(() => setViewed(readViewed(viewedKey)), [viewedKey]);
  useEffect(() => writeViewed(viewedKey, viewed), [viewedKey, viewed]);
  useEffect(() => writePanelOpen('files', filesOpen), [filesOpen]);
  useEffect(() => writePanelOpen('review', railOpen), [railOpen]);

  // Notes written here but not yet on GitHub. Every verdict button publishes
  // them, Comment included — so the panel needs the count to know whether
  // Comment is a review submit or a plain conversation comment.
  const stagedNoteCount = useMemo(
    () => reviewComments.filter((c) => c.pending).length,
    [reviewComments]
  );

  const commentsByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of reviewComments) {
      if (c.resolved) continue;
      map.set(c.file, (map.get(c.file) ?? 0) + 1);
    }
    return map;
  }, [reviewComments]);

  // A PR review's task is synthesized server-side and no client holds its id,
  // so its findings come back keyed by PR number instead.
  const { findings: prFindings, error: prFindingsError } = usePrFindings(
    data.client,
    data.port,
    prNumber
  );

  // Hands the open PR to a review agent. `confirmFork` only reports what the
  // user answered — the server refuses a fork without it either way, before
  // it fetches anything.
  const handleAgentPrReview = async (confirmFork: boolean) => {
    if (data.client === null) {
      throw new Error('The task daemon is not ready yet.');
    }
    return await data.client.startPrAgentReview(prNumber, { confirmFork });
  };

  if (data.portLoading || data.portError || data.client === null) {
    const unavailable = (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
    return tasksPage ? (
      <div className="flex h-full min-h-0 flex-col">
        <TasksPageHeader
          onBack={onBack}
          crumb={['Pull requests', `#${prNumber}`]}
        />
        <div className="min-h-0 flex-1">{unavailable}</div>
      </div>
    ) : (
      unavailable
    );
  }

  const title = repoPr.prDetail?.status.title ?? `Pull request #${prNumber}`;
  const railCount = repoPr.prDetail?.conversation.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Project › Landing › #123 Title — the PR page is a leaf of Landing, so the crumb
          walks back to it and the back button does the same in one click. */}
      <PageHeader
        leading={
          tasksPage ? (
            <TasksBackButton onBack={onBack} />
          ) : (
            <IconButton label="Back" onClick={onBack}>
              <ArrowLeft />
            </IconButton>
          )
        }
        crumb={
          tasksPage
            ? [
                'Pull requests',
                `#${prNumber} ${repoPr.prDetail?.status.title ?? selectedRepoPr?.title ?? ''}`.trim(),
              ]
            : [
                ...(projectName !== undefined && projectName !== null
                  ? [projectName]
                  : []),
                'Merge queue',
                `#${prNumber} ${title}`,
              ]
        }
        actions={
          <>
            <IconButton
              label={filesOpen ? 'Hide files' : 'Show files'}
              active={filesOpen}
              onClick={() => setFilesOpen((v) => !v)}
            >
              <PanelLeftIcon />
            </IconButton>
            <SidePanelIconButton
              label={railOpen ? 'Hide review' : `Review (${railCount})`}
              active={railOpen}
              onClick={() => setRailOpen((v) => !v)}
            />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* `overflow-hidden`, not `-auto`: the list scrolls itself internally
            (its header and viewed summary stay pinned above it), so this only
            needs to bound the track. */}
        {filesOpen && (
          <div className="shadow-hairline-right flex min-h-0 w-56 shrink-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ReviewFileTree
                files={diff?.files ?? []}
                onSelect={(path) =>
                  setJumpTo({ file: path, nonce: Date.now() })
                }
                viewed={viewed}
                commentsByFile={commentsByFile}
                findingsByFile={NO_FINDINGS_BY_FILE}
                unviewedOnly={unviewedOnly}
                onToggleUnviewedOnly={() => setUnviewedOnly((v) => !v)}
              />
            </div>
          </div>
        )}

        {/* A flex column, not a plain `min-h-0` box: `CodeView` needs a real,
            unambiguous height rather than a percentage resolved through an
            ancestor's stretch. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* A failed fetch must not read as "this PR changes nothing" — an
              empty file tree beside cheerful copy is the worse failure. */}
          {diff === undefined && repoPr.prDiffError !== null && (
            <p className="text-state-failed font-book px-4 py-3 text-[13px]">
              Couldn&rsquo;t load this pull request&rsquo;s diff from GitHub:{' '}
              {repoPr.prDiffError}
            </p>
          )}
          {diff === undefined && repoPr.prDiffError === null && (
            <p className="text-muted-foreground font-book px-4 py-3 text-[13px]">
              {repoPr.prDiffLoading
                ? 'Fetching the diff from GitHub…'
                : 'No diff to show.'}
            </p>
          )}
          {diff !== undefined && (
            <PierreReviewDiff
              client={data.client}
              // No `runId`/`meta`: there is no run worktree to load a PR's
              // file contents from, so the diff renders without hunk
              // expansion and without edit mode.
              patch={diff.patch}
              comments={reviewComments}
              viewed={viewed}
              onToggleViewed={(file) => setViewed((v) => toggleViewed(v, file))}
              scrollTo={jumpTo}
              onAdd={repoPr.handleAddReviewComment}
              onResolve={repoPr.handleResolveReviewComment}
              onReply={repoPr.handleReplyReviewComment}
              // Suggestions are committed onto a run's own branch, so a PR
              // has no worktree to apply into — the Apply affordance is
              // withheld rather than shown dead.
              destination="github"
            />
          )}
        </div>

        {railOpen && (
          <div className="shadow-hairline-left flex min-h-0 w-80 shrink-0 flex-col gap-3 overflow-y-auto px-3 py-3">
            {/* Owns the PR's status header too — one source, refreshed by every
                action here, rather than a second copy off the 60s repo poll. */}
            <PrReviewPanel
              detail={repoPr.prDetail}
              loading={repoPr.prDetailLoading}
              error={repoPr.prDetailError}
              onReview={repoPr.handleReview}
              onComment={repoPr.handleComment}
              stagedNotes={stagedNoteCount}
              onAgentReview={handleAgentPrReview}
              findings={prFindings}
              findingsError={prFindingsError}
              forkOwner={
                selectedRepoPr?.isCrossRepository === true
                  ? selectedRepoPr.headRepositoryOwner
                  : undefined
              }
            />
            {/* An empty thread list must not read as "nobody commented" when
                the GitHub pull is what failed. */}
            {repoPr.reviewCommentsError !== null && (
              <p className="text-state-failed font-book text-[13px]">
                Couldn&rsquo;t load this pull request&rsquo;s threads:{' '}
                {repoPr.reviewCommentsError}
              </p>
            )}
            <ReviewThreadIndex
              comments={reviewComments}
              onResolve={repoPr.handleResolveReviewComment}
              onReply={repoPr.handleReplyReviewComment}
              onJumpTo={(c) =>
                setJumpTo({ file: c.file, line: c.line, nonce: Date.now() })
              }
              destination="github"
            />
            {/* Says plainly what this list is and is not: notes here are
                staged until a verdict publishes them, and a reply written on
                github.com never comes back into a thread (the mirror drops
                in-reply payloads) — it lands in the conversation above. */}
            <p className="text-muted-foreground font-book text-[12px]">
              Notes stay staged until you comment, approve or request changes
              above, then publish to GitHub as one review. Replies written on
              github.com show in the conversation, not in these threads.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// A PR's findings live in the rail's panel, not on its file tree — one shared
// empty map so the tree keeps a stable prop identity across renders.
const NO_FINDINGS_BY_FILE: ReadonlyMap<string, Finding[]> = new Map();
