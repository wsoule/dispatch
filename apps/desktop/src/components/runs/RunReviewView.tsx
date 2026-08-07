import type {
  ApiClient,
  DiffResult,
  MergeQueueSnapshot,
  RunMeta,
} from '@dispatch/client';
import { canPostReviewToPr } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { computeStack, isDone } from '@dispatch/core/graph';
import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListOrdered,
  MessageSquarePlus,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { isTerminalRunState } from '../../lib/runState';
import { PierreReviewDiff } from './PierreReviewDiff';
import { QueueMergeControl } from './QueueMergeControl';
import { ReviewCommentsPanel } from './ReviewCommentsPanel';
import { RunDiffView } from './RunDiffView';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

interface RunReviewViewProps {
  /** Feeds `PierreReviewDiff`'s contents loader — omitted only by call sites that predate it,
   * which keep rendering without hunk expansion rather than failing to compile. */
  client?: ApiClient | null;
  meta: RunMeta;
  diff: DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
  /** Whether this project can use the PR review action at all (gh + a configured git remote —
   * see `GET /api/health`'s `pr` flag). The action is hidden entirely rather than shown
   * disabled when this is false, since there's nothing the person could do in-app to fix it. */
  prCapability: boolean;
  /** The merge queue's live snapshot, so the "Queue merge" control can show this run's own
   * position/state instead of a plain static button once it has an entry. `null` while the
   * query hasn't resolved yet — treated the same as an empty queue. */
  mergeQueue: MergeQueueSnapshot | null;
  /** Full project task list — used to compute this run's task's stack (see
   * `computeStack`) so the "Queue stack" action can show/hide itself and its count. */
  tasks: TaskDoc[];
  /** Per-task latest run, same map `StackRail` uses — lets the stack-count check below
   * look up every OTHER stack member's latest run without a second fetch. */
  latestRunByTaskId: Map<string, RunMeta>;
  onMerge: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onRequestChanges: (text: string) => Promise<void>;
  onOpenPr: () => Promise<void>;
  /** Jumps to the Pull requests tab (this run's PR, once opened, is reviewed there rather than
   * inline here — keeps the run surface from nesting a whole second review surface inside it). */
  onViewPr: () => void;
  onQueueMerge: () => Promise<void>;
  onQueueStack: () => Promise<void>;
  /** Line-level review comments on this run, and the actions over them. Optional so the older
   * call sites that never had them keep compiling with the panel hidden. */
  reviewComments?: import('@dispatch/client').ReviewComment[];
  /** Resolves with the created comment — see `PierreReviewDiff`'s `onAdd` for why. */
  onAddComment?: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
    /** Replacement text for the commented lines. Omitted for a prose-only comment. */
    suggestion?: string;
  }) => Promise<import('@dispatch/client').ReviewComment>;
  onResolveComment?: (commentId: string, resolved: boolean) => Promise<void>;
  onReplyComment?: (commentId: string, body: string) => Promise<void>;
  /** Commits a comment's suggestion onto the run branch — see `PierreReviewDiff`'s `onApply`. */
  onApplySuggestion?: (commentId: string) => Promise<void>;
  /** Submits the staged review — publishes its comments, then acts on the
   * verdict. `postToGitHub` also mirrors it onto this run's PR as one
   * review; without it the review stays off GitHub. */
  onSubmitReview?: (
    verdict: import('@dispatch/client').ReviewVerdict,
    body: string,
    postToGitHub: boolean
  ) => Promise<{ published: number; error?: string }>;
}

/**
 * Review surface for a terminal run: the shared unified diff (RunDiffView) plus the local
 * review actions — merge / discard / request-changes, and Open PR when the project supports it.
 * Deliberately does NOT host the GitHub PR review UI: once a PR is open, reviewing it (status,
 * conversation, approve/request-changes) happens in the top-level Pull requests tab, so this
 * surface stays a single diff + one action row instead of stacking a second review surface
 * under the first.
 */
export function RunReviewView({
  client,
  meta,
  diff,
  diffLoading,
  diffError,
  prCapability,
  mergeQueue,
  tasks,
  latestRunByTaskId,
  onMerge,
  onDiscard,
  onRequestChanges,
  onOpenPr,
  onViewPr,
  onQueueMerge,
  onQueueStack,
  reviewComments,
  onAddComment,
  onResolveComment,
  onReplyComment,
  onApplySuggestion,
  onSubmitReview,
}: RunReviewViewProps) {
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changesDraft, setChangesDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How many members of this run's task's stack (its blockedBy-connected
  // component) are worth a "Queue stack" action: each one whose latest run is
  // either still reviewable (terminal + unreviewed, the same bar
  // `QueueMergeControl` itself uses) or already sitting in the merge queue.
  // The button only shows once this is >1 — a stack where this run is the
  // only reviewable member has nothing extra for the stack action to do
  // beyond the plain "Queue merge" button already sitting next to it.
  //
  // Mirrors the server's own `enqueueStack` skip rule: a stack member whose
  // task is already done/cancelled is excluded up front, same as there —
  // otherwise this count (and the button it gates) could promise more work
  // than `enqueueStack` would actually enqueue.
  const stackQueueableCount = useMemo(() => {
    const stack = computeStack(tasks, meta.taskId);
    if (stack === null) return 0;
    const taskById = new Map(tasks.map((t) => [t.meta.id, t]));
    let count = 0;
    for (const id of stack.order) {
      const task = taskById.get(id);
      if (task !== undefined && isDone(task)) continue;
      const run = id === meta.taskId ? meta : latestRunByTaskId.get(id);
      if (run === undefined) continue;
      const reviewable =
        isTerminalRunState(run.state) && run.reviewedAt === undefined;
      const queued =
        mergeQueue?.entries.some((e) => e.runId === run.id) ?? false;
      if (reviewable || queued) count += 1;
    }
    return count;
  }, [tasks, meta, latestRunByTaskId, mergeQueue]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRequestChanges() {
    if (changesDraft.trim() === '') return;
    await run(async () => {
      await onRequestChanges(changesDraft.trim());
      setChangesDraft('');
      setRequestingChanges(false);
    });
  }

  const hasOpenPr = meta.prUrl !== undefined;
  const canOpenPr = prCapability && meta.reviewedAt === undefined && !hasOpenPr;

  // Shared between both action-row branches below (open-PR vs plain) so the
  // "Queue stack" affordance always sits right next to "Queue merge",
  // whichever branch is showing.
  const queueStackButton =
    stackQueueableCount > 1 ? (
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title={`Enqueue every reviewable run in this stack, blockers first (${stackQueueableCount})`}
        onClick={() => void run(onQueueStack)}
      >
        <ListOrdered className="size-3.5" />
        Queue stack ({stackQueueableCount})
      </Button>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {error !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-4 overflow-hidden">
        <div className="min-h-0 overflow-auto">
          {/* Pierre's CodeView with comment threads injected as line annotations — same
              renderer as everywhere else, so syntax highlighting, virtualisation and hunk
              expansion all come along. */}
          {onAddComment !== undefined &&
          onResolveComment !== undefined &&
          onReplyComment !== undefined &&
          diff !== undefined ? (
            <PierreReviewDiff
              client={client}
              runId={meta.id}
              meta={meta}
              patch={diff.patch}
              comments={reviewComments ?? []}
              onAdd={onAddComment}
              onResolve={onResolveComment}
              onReply={onReplyComment}
              onApply={onApplySuggestion}
            />
          ) : (
            <RunDiffView
              diff={diff}
              diffLoading={diffLoading}
              diffError={diffError}
            />
          )}
        </div>
        {onAddComment !== undefined &&
          onResolveComment !== undefined &&
          onReplyComment !== undefined &&
          onSubmitReview !== undefined && (
            <div className="min-h-0 overflow-auto">
              <ReviewCommentsPanel
                comments={reviewComments ?? []}
                onResolve={onResolveComment}
                onReply={onReplyComment}
                onSubmit={onSubmitReview}
                canPostToGitHub={canPostReviewToPr(meta.prUrl)}
              />
            </div>
          )}
      </div>

      {hasOpenPr ? (
        <div className="border-border flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-muted-foreground text-[12px]">
            A PR is open for this run — review it in the Pull requests tab.
          </span>
          <div className="flex items-center gap-2">
            <QueueMergeControl
              meta={meta}
              mergeQueue={mergeQueue}
              busy={busy}
              onQueueMerge={() => void run(onQueueMerge)}
            />
            {queueStackButton}
            <Button variant="secondary" size="sm" onClick={onViewPr}>
              <GitPullRequest className="size-3.5" />
              Review PR
            </Button>
          </div>
        </div>
      ) : requestingChanges ? (
        <div className="animate-in fade-in-0 flex flex-col gap-2 duration-150">
          <Textarea
            rows={3}
            placeholder="Describe what should change…"
            value={changesDraft}
            onChange={(e) => setChangesDraft(e.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setRequestingChanges(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void submitRequestChanges()}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-border flex items-center justify-end gap-2 border-t pt-3">
          <QueueMergeControl
            meta={meta}
            mergeQueue={mergeQueue}
            busy={busy}
            onQueueMerge={() => void run(onQueueMerge)}
          />
          {queueStackButton}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setRequestingChanges(true)}
          >
            <MessageSquarePlus className="size-3.5" />
            Request changes
          </Button>
          {canOpenPr && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(onOpenPr)}
            >
              <ExternalLink className="size-3.5" />
              Open PR
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="hover:text-destructive"
            onClick={() => void run(onDiscard)}
          >
            <Trash2 className="size-3.5" />
            Discard
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void run(onMerge)}>
            <GitMerge className="size-3.5" />
            Merge
          </Button>
        </div>
      )}
    </div>
  );
}
