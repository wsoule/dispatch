import type {
  DiffResult,
  MergeQueueEntryState,
  MergeQueueSnapshot,
  RunMeta,
} from '@dispatch/client';
import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListOrdered,
  MessageSquarePlus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

import { RunDiffView } from './RunDiffView';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

interface RunReviewViewProps {
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
  onMerge: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onRequestChanges: (text: string) => Promise<void>;
  onOpenPr: () => Promise<void>;
  /** Jumps to the Pull requests tab (this run's PR, once opened, is reviewed there rather than
   * inline here — keeps the run surface from nesting a whole second review surface inside it). */
  onViewPr: () => void;
  onQueueMerge: () => Promise<void>;
}

// Live-state label for a run currently sitting in the merge queue — 'queued' gets its own
// position-aware label built inline (see `QueueMergeControl` below), every other non-terminal
// state maps to a short present-progressive label straight off the snapshot.
const QUEUE_STATE_LABEL: Partial<Record<MergeQueueEntryState, string>> = {
  'waiting-blockers': 'Waiting on blockers…',
  rebasing: 'Rebasing…',
  verifying: 'Verifying…',
  merging: 'Merging…',
};

/**
 * The "Queue merge" control: a plain button when this run has no merge-queue entry, live state
 * text (e.g. "Queued · #2", "Rebasing…") while an entry is actively in the queue, and — once a
 * past attempt has failed without the run ever becoming reviewed — the failure reason plus a
 * re-enabled button so the person can retry. Disabled (with a reason tooltip) once the run has
 * already been reviewed, mirroring the server's own 409 for that case.
 */
function QueueMergeControl({
  meta,
  mergeQueue,
  busy,
  onQueueMerge,
}: {
  meta: RunMeta;
  mergeQueue: MergeQueueSnapshot | null;
  busy: boolean;
  onQueueMerge: () => void;
}) {
  const entries = mergeQueue?.entries ?? [];
  const activeEntry = entries.find((e) => e.runId === meta.id);
  const queuePosition =
    activeEntry !== undefined ? entries.indexOf(activeEntry) + 1 : undefined;
  // A failed attempt moves out of `entries` into `history` — surfaced only when there's no
  // active entry for this run, since a fresh enqueue after a failure starts a new entry.
  const failedEntry =
    activeEntry === undefined
      ? mergeQueue?.history.find(
          (e) => e.runId === meta.id && e.state === 'failed'
        )
      : undefined;
  const alreadyReviewed = meta.reviewedAt !== undefined;
  const disabledReason = alreadyReviewed
    ? 'This run has already been reviewed'
    : undefined;

  return (
    <div className="flex items-center gap-2">
      {activeEntry !== undefined ? (
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[12px]">
          <ListOrdered className="size-3.5" />
          {activeEntry.state === 'queued'
            ? `Queued · #${queuePosition}`
            : (QUEUE_STATE_LABEL[activeEntry.state] ?? activeEntry.state)}
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || alreadyReviewed}
          title={disabledReason}
          onClick={onQueueMerge}
        >
          <ListOrdered className="size-3.5" />
          Queue merge
        </Button>
      )}
      {failedEntry !== undefined && (
        <span
          className="text-destructive max-w-40 truncate text-[11px]"
          title={failedEntry.reason}
        >
          Failed: {failedEntry.reason ?? 'unknown error'}
        </span>
      )}
    </div>
  );
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
  meta,
  diff,
  diffLoading,
  diffError,
  prCapability,
  mergeQueue,
  onMerge,
  onDiscard,
  onRequestChanges,
  onOpenPr,
  onViewPr,
  onQueueMerge,
}: RunReviewViewProps) {
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changesDraft, setChangesDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {error !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <RunDiffView
          diff={diff}
          diffLoading={diffLoading}
          diffError={diffError}
        />
      </div>

      {hasOpenPr ? (
        <div className="border-border flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-muted-foreground text-[12px]">
            A PR is open for this run — review it in the Pull requests tab.
          </span>
          <Button variant="secondary" size="sm" onClick={onViewPr}>
            <GitPullRequest className="size-3.5" />
            Review PR
          </Button>
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
