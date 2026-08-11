import type { Finding } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { PierreReviewDiff } from '../components/runs/PierreReviewDiff';
import { PrReviewPanel } from '../components/runs/PrReviewPanel';
import { ReviewFileTree } from '../components/runs/ReviewFileTree';
import { ReviewThreadIndex } from '../components/runs/ReviewThreadIndex';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { repoPrsKey } from '../hooks/useDispatchProject';
import { usePrFindings } from '../hooks/useOrchestration';
import { repoPrDetailKey, useRepoPrDetail } from '../hooks/useRepoPrDetail';
import { normalizeDiffFilePath } from '../lib/pierreTree';
import { readPanelOpen, writePanelOpen } from '../lib/reviewPanels';
import { reviewTargetKey } from '../lib/reviewTarget';
import { readViewed, toggleViewed, writeViewed } from '../lib/reviewViewed';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { MetaText } from '@/ui/chrome';
import { IconToggle } from '@/ui/chrome/IconToggle';
import { StateDot } from '@/ui/chrome/StateDot';

interface PrReviewViewProps {
  data: DispatchProjectData;
  /** Which repo pull request is open — `navReducer`'s `activePrNumber`. */
  prNumber: number;
  onBack: () => void;
}

// How often the open-PR list is re-fetched while this page is on screen.
const REPO_PRS_POLL_MS = 60_000;

/**
 * Reviewing one repo pull request, full-page.
 *
 * The same frame a run's diff gets in the task view — a file list with viewed
 * ticks on the left, one file's diff at a time in the middle, threads on the
 * right — with the diff fetched from GitHub rather than read out of a
 * worktree. Showing one file at a time is the point of the file list: a
 * forty-file diff rendered as one scroll is unreviewable, and "which have I
 * actually read" is the question a reviewer is really tracking.
 *
 * A note written here is staged locally and published to GitHub as part of one
 * review when the rail's panel submits a verdict. That panel is default-open
 * (its own `review` panel key), since it is the only place to approve a PR and
 * the only place from which a staged note reaches GitHub.
 */
export function PrReviewView({ data, prNumber, onBack }: PrReviewViewProps) {
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

  const paths = useMemo(
    () => (diff?.files ?? []).map((f) => normalizeDiffFilePath(f.path)),
    [diff]
  );

  // Viewed ticks are stored per target, so a PR's ticks never collide with a
  // run's.
  const viewedKey = reviewTargetKey({ kind: 'pr', number: prNumber });

  const [selected, setSelected] = useState<string | null>(null);
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
  // Which thread the diff should scroll to. Carries a nonce so clicking the same
  // thread twice still jumps — a value-equal object would not re-fire the effect.
  const [jumpTo, setJumpTo] = useState<{
    file: string;
    line: number;
    nonce: number;
  } | null>(null);

  // Re-read when the PR changes, so opening a different one does not inherit
  // the last one's ticks.
  useEffect(() => setViewed(readViewed(viewedKey)), [viewedKey]);
  useEffect(() => writeViewed(viewedKey, viewed), [viewedKey, viewed]);
  useEffect(() => writePanelOpen('files', filesOpen), [filesOpen]);
  useEffect(() => writePanelOpen('review', railOpen), [railOpen]);

  // Only correct the selection when its file has left the diff underneath.
  useEffect(() => {
    if (selected !== null && !paths.includes(selected)) setSelected(null);
  }, [paths, selected]);

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
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Header
        onBack={onBack}
        title={repoPr.prDetail?.status.title ?? `Pull request #${prNumber}`}
        filesOpen={filesOpen}
        onToggleFiles={() => setFilesOpen((v) => !v)}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
        railCount={repoPr.prDetail?.conversation.length ?? 0}
      />

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* `overflow-hidden`, not `-auto`: the list scrolls itself internally
            (its header and viewed summary stay pinned above it), so this only
            needs to bound the track. */}
        {filesOpen && (
          <div className="flex min-h-0 w-56 shrink-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ReviewFileTree
                files={diff?.files ?? []}
                onSelect={setSelected}
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
          {selected === null && repoPr.prDiffError !== null && (
            <p className="text-destructive p-4 text-[12.5px]">
              Couldn&rsquo;t load this pull request&rsquo;s diff from GitHub:{' '}
              {repoPr.prDiffError}
            </p>
          )}
          {selected === null && repoPr.prDiffError === null && (
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
                client={data.client}
                // No `runId`/`meta`: there is no run worktree to load a PR's
                // file contents from, so the diff renders without hunk
                // expansion and without edit mode.
                patch={diff.patch}
                only={selected}
                comments={reviewComments}
                viewed={viewed}
                scrollTo={jumpTo}
                onAdd={repoPr.handleAddReviewComment}
                onResolve={repoPr.handleResolveReviewComment}
                onReply={repoPr.handleReplyReviewComment}
                // Suggestions are committed onto a run's own branch, so a PR
                // has no worktree to apply into — the Apply affordance is
                // withheld rather than shown dead.
                destination="github"
              />
            </>
          )}
        </div>

        {railOpen && (
          <div className="flex min-h-0 w-72 shrink-0 flex-col gap-3 overflow-y-auto">
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
              <p className="text-destructive text-[12.5px]">
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
            <p className="text-muted-foreground text-[11.5px]">
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

/**
 * Sits above the open file's diff: its path, unresolved-comment count, and
 * viewed toggle.
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
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        role="checkbox"
        aria-checked={isViewed}
        aria-label={`Mark ${path} viewed`}
        onClick={onToggleViewed}
        className={cn(
          'size-3.5 shrink-0 rounded-sm p-0 hover:bg-transparent',
          isViewed
            ? 'bg-state-review text-background hover:bg-state-review'
            : 'shadow-hairline'
        )}
      >
        {isViewed && <Check className="size-2.5" />}
      </Button>
    </div>
  );
}

/**
 * Two rows, not three, and the title at a size that does not wrap: this sits
 * above a diff that wants every pixel of height.
 */
function Header({
  onBack,
  title,
  filesOpen,
  onToggleFiles,
  railOpen,
  onToggleRail,
  railCount,
}: {
  onBack: () => void;
  title: string;
  filesOpen: boolean;
  onToggleFiles: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  railCount: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground h-auto shrink-0 gap-1.5 p-0 text-[11.5px] font-normal hover:bg-transparent"
        >
          <ArrowLeft className="size-3" />
          Back
        </Button>
        <StateDot state="review" pulse={false} />
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">
          {title}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1" />
        <IconToggle
          on={filesOpen}
          onClick={onToggleFiles}
          label={filesOpen ? 'Hide files' : 'Show files'}
          className="text-accent-foreground hover:text-accent-foreground data-[state=on]:text-accent-foreground border-none p-0 text-[11px] hover:bg-transparent data-[state=on]:bg-transparent"
        >
          {filesOpen ? 'Hide files' : 'Show files'}
        </IconToggle>
        <IconToggle
          on={railOpen}
          onClick={onToggleRail}
          label={railOpen ? 'Hide review' : `Review (${railCount})`}
          className="text-accent-foreground hover:text-accent-foreground data-[state=on]:text-accent-foreground border-none p-0 text-[11px] hover:bg-transparent data-[state=on]:bg-transparent"
        >
          {railOpen ? 'Hide review' : `Review (${railCount})`}
        </IconToggle>
      </div>
    </div>
  );
}
