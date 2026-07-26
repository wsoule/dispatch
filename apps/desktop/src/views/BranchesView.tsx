import type { BranchEntry, BranchEntryStatus } from '@dispatch/client';
import {
  AlertTriangle,
  GitBranch,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';

interface BranchesViewProps {
  data: DispatchProjectData;
  onOpenRun: (runId: string) => void;
}

// The three groups rows are bucketed into, ordered by how much they need a
// human: unowned refs first, then work awaiting a verdict, then read-only live
// runs. `leftover` groups with `orphan` rather than with `reviewable` because a
// leftover run has ALREADY been reviewed — what it shares with an orphan is
// that nothing owns the ref anymore and no automatic path will reclaim it.
const GROUPS: {
  id: 'attention' | 'reviewable' | 'active';
  label: string;
  blurb: string;
  statuses: BranchEntryStatus[];
}[] = [
  {
    id: 'attention',
    label: 'Orphaned',
    blurb:
      'No run claims these refs — left behind by a deleted transcript or a crash. Nothing else will ever clean them up.',
    statuses: ['orphan', 'leftover'],
  },
  {
    id: 'reviewable',
    label: 'Needs review',
    blurb:
      'The agent finished but nobody merged or discarded the work, so the worktree and branch are still on disk.',
    statuses: ['reviewable'],
  },
  {
    id: 'active',
    label: 'Active',
    blurb: 'An agent is working in these worktrees right now.',
    statuses: ['active'],
  },
];

const STATUS_CHIP: Record<BranchEntryStatus, { label: string; cls: string }> = {
  active: {
    label: 'Live',
    cls: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  },
  reviewable: {
    label: 'Unreviewed',
    cls: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  },
  leftover: {
    label: 'Cleanup failed',
    cls: 'border-red-500/40 text-red-600 dark:text-red-400',
  },
  orphan: {
    label: 'Orphan',
    cls: 'border-muted-foreground/40 text-muted-foreground',
  },
};

// What a pending confirmation is about. `force` deletes are the only
// irreversible action on this surface, so they get an explicit dialog naming
// the number of commits at stake rather than a one-click button.
interface PendingDelete {
  branch: string;
  ahead: number;
  force: boolean;
}

function BranchRow({
  entry,
  busy,
  onOpenRun,
  onDiscard,
  onFreeDisk,
  onRequestDelete,
}: {
  entry: BranchEntry;
  busy: boolean;
  onOpenRun: (runId: string) => void;
  onDiscard: (runId: string) => void;
  onFreeDisk: () => void;
  onRequestDelete: (pending: PendingDelete) => void;
}) {
  const chip = STATUS_CHIP[entry.status];
  const canAct = entry.status !== 'active';
  // Discard is a *review* decision, not a git operation, so it's only offered
  // where one is still owed: a terminal run nobody has ruled on yet. It routes
  // through the same endpoint the run's review surface uses, which reopens the
  // task and records the verdict on top of removing the worktree and branch.
  const canDiscard = entry.status === 'reviewable' && entry.runId !== undefined;
  return (
    <div className="border-border/60 hover:bg-muted/40 flex items-center gap-3 rounded-md border px-3 py-2 transition-colors duration-150">
      <GitBranch className="text-muted-foreground size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12px]">{entry.branch}</span>
          <span
            className={cn(
              'shrink-0 rounded border px-1.5 py-px text-[10px] font-medium',
              chip.cls
            )}
          >
            {chip.label}
          </span>
          {entry.dirty && (
            <span
              title="Uncommitted changes in this worktree"
              className="shrink-0 rounded border border-orange-500/40 px-1.5 py-px text-[10px] font-medium text-orange-600 dark:text-orange-400"
            >
              Uncommitted
            </span>
          )}
        </div>
        <div className="text-muted-foreground/80 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
          {entry.taskTitle !== undefined && (
            <span className="truncate">{entry.taskTitle}</span>
          )}
          {entry.runId !== undefined && (
            <button
              type="button"
              onClick={() => onOpenRun(entry.runId)}
              className="hover:text-foreground font-mono underline-offset-2 hover:underline"
            >
              {entry.runId}
            </button>
          )}
          <span title="Commits this branch has that its base does not">
            ↑{entry.ahead}
          </span>
          {entry.mergedIntoBase && <span>merged</span>}
          {!entry.worktreeExists && <span>no worktree</span>}
          {entry.lastCommitAt !== undefined && (
            <span>{formatRelativeTimeFromIso(entry.lastCommitAt)}</span>
          )}
        </div>
      </div>
      {busy ? (
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
      ) : (
        canAct && (
          <div className="flex shrink-0 items-center gap-1">
            {canDiscard && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                onClick={() => onDiscard(entry.runId)}
                title="Reject this work: removes the worktree and branch, and reopens the task"
              >
                <Undo2 className="size-3.5" />
                Discard
              </Button>
            )}
            {entry.worktreeExists && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                onClick={onFreeDisk}
                title="Delete the working copy but keep the branch, so the work stays recoverable"
              >
                <HardDriveDownload className="size-3.5" />
                Free disk
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive h-7 gap-1.5 text-[12px]"
              onClick={() =>
                onRequestDelete({
                  branch: entry.branch,
                  ahead: entry.ahead,
                  force: !entry.mergedIntoBase,
                })
              }
              title="Delete the worktree and the branch ref"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </div>
        )
      )}
    </div>
  );
}

/**
 * The Branches surface: every `dispatch/*` worktree and branch that exists in
 * git right now, joined with whatever run claims it.
 *
 * This exists because run review is the *only* path that cleans a branch up. A
 * run that finished and was never reviewed keeps its worktree forever, and a
 * ref whose worktree directory is already gone is invisible to every automatic
 * code path on the server. Both leak silently; this is where they become
 * visible and actionable.
 *
 * Three actions, in increasing severity: "Free disk" reclaims the working copy
 * but keeps the ref (recoverable via `git worktree add`); "Delete" removes both
 * when the commits already landed on the base branch; and a forced delete —
 * behind a confirmation naming the commit count — destroys unmerged work.
 * Discarding a run is deliberately NOT here: that's a review decision, and it
 * lives on the run's own review surface where the diff is in front of you.
 */
export function BranchesView({ data, onOpenRun }: BranchesViewProps) {
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        entries: data.branches.filter((e) => group.statuses.includes(e.status)),
      })),
    [data.branches]
  );

  // Every orphan whose commits already landed on its base — the only set that
  // can be deleted in bulk without risking work, since `mergedIntoBase` is
  // proof there is nothing left to lose.
  const mergedOrphans = useMemo(
    () =>
      data.branches.filter((e) => e.status === 'orphan' && e.mergedIntoBase),
    [data.branches]
  );

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // Wraps every branch action so a server 409 (live run, open PR, stacked
  // dependent, unmerged without force) is shown verbatim instead of vanishing
  // into an unhandled rejection.
  async function run(branch: string, action: () => Promise<void>) {
    setBusyBranch(branch);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyBranch(null);
    }
  }

  async function deleteAllMergedOrphans() {
    setActionError(null);
    for (const entry of mergedOrphans) {
      await run(entry.branch, () => data.handleDeleteBranch(entry.branch));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="view-topbar-title">Branches</h1>
        <div className="flex items-center gap-2">
          {mergedOrphans.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              onClick={() => void deleteAllMergedOrphans()}
            >
              <Trash2 className="size-3.5" />
              Delete {mergedOrphans.length} merged orphan
              {mergedOrphans.length === 1 ? '' : 's'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => void data.handleRefreshBranches()}
            title="Git state can change outside the app"
          >
            <RefreshCw
              className={cn('size-3.5', data.branchesLoading && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>

      {actionError !== null && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-px size-4 shrink-0" />
          <span className="min-w-0 flex-1">{actionError}</span>
        </div>
      )}

      {data.branches.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-[13px]">
          <GitBranch className="size-5" />
          <span>No dispatch branches on disk.</span>
          <span className="text-[12px]">
            Every run's branch has been merged, discarded, or cleaned up.
          </span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
          {grouped.map(
            (group) =>
              group.entries.length > 0 && (
                <section key={group.id} className="flex flex-col gap-2">
                  <div className="flex flex-col gap-0.5">
                    <h2 className="text-[13px] font-medium">
                      {group.label}
                      <span className="text-muted-foreground ml-1.5 font-normal">
                        {group.entries.length}
                      </span>
                    </h2>
                    <p className="text-muted-foreground/80 text-[11px]">
                      {group.blurb}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {group.entries.map((entry) => (
                      <BranchRow
                        key={entry.branch}
                        entry={entry}
                        busy={busyBranch === entry.branch}
                        onOpenRun={onOpenRun}
                        onDiscard={(runId) =>
                          void run(entry.branch, () =>
                            data.handleReview(runId, 'discard')
                          )
                        }
                        onFreeDisk={() =>
                          void run(entry.branch, () =>
                            data.handleFreeBranchDisk(entry.branch)
                          )
                        }
                        onRequestDelete={setPendingDelete}
                      />
                    ))}
                  </div>
                </section>
              )
          )}
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingDelete?.force === true
                ? 'Delete unmerged branch?'
                : 'Delete branch?'}
            </DialogTitle>
            <DialogDescription>
              {pendingDelete?.force === true ? (
                <>
                  <span className="font-mono">{pendingDelete.branch}</span> has{' '}
                  {pendingDelete.ahead} commit
                  {pendingDelete.ahead === 1 ? '' : 's'} that never landed on
                  its base branch. Deleting it destroys that work permanently.
                  Use “Free disk” instead if you only want the space back.
                </>
              ) : (
                <>
                  <span className="font-mono">{pendingDelete?.branch}</span> is
                  already merged into its base, so deleting it removes the
                  worktree and ref without losing any commits.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const pending = pendingDelete;
                setPendingDelete(null);
                if (pending === null) return;
                void run(pending.branch, () =>
                  data.handleDeleteBranch(pending.branch, {
                    force: pending.force,
                  })
                );
              }}
            >
              {pendingDelete?.force === true
                ? 'Delete anyway'
                : 'Delete branch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
