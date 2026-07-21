import type { DiffFile, DiffResult, RunMeta } from '@dispatch/client';
import { PatchDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import {
  CircleAlert,
  ExternalLink,
  FileX,
  GitMerge,
  MessageSquarePlus,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { PierreWorkerPool } from './PierreWorkerPool';
import { RunStatePill } from './RunStatePill';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';

// The changed-files tree for a run's diff, git-status decorated (added/
// modified/deleted/renamed). A separate component (rather than inlined in
// RunReviewView) because `useFileTree`'s model is constructed once from its
// first-render options — see useFileTree.js's `useState(() => new
// FileTree(options))` — so this only mounts once `files` is known, and
// re-syncs imperatively via `resetPaths`/`setGitStatus` if the diff is ever
// refetched while the view stays open.
//
// Note: the tree/diff widgets themselves (`FileTree`, `PatchDiff`) are the
// Pierre package's own internals and are out of scope for this redesign —
// only the chrome/frame around them (headers, panes, borders) is restyled
// here; their look is themed globally via styles/pierreTheme.css instead.
function ChangedFilesTree({ files }: { files: DiffFile[] }) {
  const paths = useMemo(
    () => files.map((f) => normalizeDiffFilePath(f.path)),
    [files]
  );
  const gitStatus = useMemo(
    () =>
      files.map((f) => ({
        path: normalizeDiffFilePath(f.path),
        status: toTreeGitStatus(f.status),
      })),
    [files]
  );
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  return (
    <FileTree
      model={model}
      header={
        <span className="text-muted-foreground block px-3 py-2 text-[11px] tracking-wide uppercase">
          Changed files
        </span>
      }
      className="size-full"
    />
  );
}

interface RunReviewViewProps {
  meta: RunMeta;
  diff: DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
  /** Whether this project can use the PR review action at all (gh + a configured git remote —
   * see `GET /api/health`'s `pr` flag). The action is hidden entirely rather than shown
   * disabled when this is false, since there's nothing the person could do in-app to fix it. */
  prCapability: boolean;
  onMerge: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onRequestChanges: (text: string) => Promise<void>;
  onOpenPr: () => Promise<void>;
}

/**
 * Review surface for a terminal run (finished/failed/cancelled): the unified diff (@pierre/diffs
 * PatchDiff) alongside a git-status-decorated changed-files tree (@pierre/trees FileTree), with
 * merge / discard / request-changes actions. `diff`/`diffLoading`/`diffError` are owned by the
 * caller (RunsView, via `useDispatchProject`'s `GET /api/runs/:id/diff` query) rather than
 * fetched here, matching this codebase's presentational-component convention for the primary
 * dispatch views. Merge is the single primary/filled action on this surface per the redesign
 * brief; Request changes/Open PR/Discard are ghost buttons.
 */
export function RunReviewView({
  meta,
  diff,
  diffLoading,
  diffError,
  prCapability,
  onMerge,
  onDiscard,
  onRequestChanges,
  onOpenPr,
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

  // Once a PR has been opened, that's the review path in progress — the
  // run stays un-reviewed (`reviewedAt` unset) until PrManager's poller sees
  // GitHub report it merged, so merge/discard/request-changes are hidden in
  // favor of a single "waiting to merge" status + the PR link. The action
  // itself is only offered while nothing has claimed this run yet.
  const hasOpenPr = meta.prUrl !== undefined;
  const canOpenPr = prCapability && meta.reviewedAt === undefined && !hasOpenPr;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="border-border flex items-center gap-3 border-b pb-3">
        <RunStatePill state={meta.state} />
        {meta.costUsd !== undefined && (
          <span className="text-muted-foreground font-mono text-[12px]">
            ${meta.costUsd.toFixed(2)}
          </span>
        )}
        {meta.error !== undefined && (
          <span className="text-destructive truncate text-[12px]">
            {meta.error}
          </span>
        )}
        {hasOpenPr && (
          <a
            className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-600 transition-colors duration-150 hover:bg-blue-500/20 dark:text-blue-400"
            href={meta.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            PR opened
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {error !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
          {error}
        </div>
      )}

      {diffLoading && (
        <div className="grid grid-cols-[14rem_1fr] gap-3">
          <Skeleton className="h-80 rounded-md" />
          <Skeleton className="h-80 rounded-md" />
        </div>
      )}

      {diffError !== null && (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <CircleAlert className="size-5" />
          <p className="text-[13px]">
            Couldn&rsquo;t load the diff: {diffError}
          </p>
        </div>
      )}

      {!diffLoading && diffError === null && diff !== undefined && (
        <div className="grid min-h-80 flex-1 grid-cols-[14rem_1fr] gap-3">
          <div className="border-border bg-muted/30 overflow-auto rounded-md border">
            {diff.files.length === 0 ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                <FileX className="size-4" />
                <p className="text-[12px]">No file changes recorded.</p>
              </div>
            ) : (
              <ChangedFilesTree files={diff.files} />
            )}
          </div>
          <div className="border-border overflow-auto rounded-md border">
            {diff.patch.trim() === '' ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                <FileX className="size-4" />
                <p className="text-[12px]">No changes to show for this run.</p>
              </div>
            ) : (
              <PierreWorkerPool>
                <PatchDiff patch={diff.patch} />
              </PierreWorkerPool>
            )}
          </div>
        </div>
      )}

      {hasOpenPr ? (
        <p className="text-muted-foreground text-[12px]">
          Waiting for the PR to merge — this run will move to done automatically
          once it does.
        </p>
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
        <div className="border-border flex justify-end gap-2 border-t pt-3">
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
