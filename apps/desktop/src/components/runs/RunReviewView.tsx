import type { DiffResult, MergeQueueSnapshot, RunMeta } from '@dispatch/client';
import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquarePlus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

import { QueueMergeControl } from './QueueMergeControl';
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
          <div className="flex items-center gap-2">
            <QueueMergeControl
              meta={meta}
              mergeQueue={mergeQueue}
              busy={busy}
              onQueueMerge={() => void run(onQueueMerge)}
            />
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
