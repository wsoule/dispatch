import type {
  ApiClient,
  GitLogEntry,
  GitStash,
  GitStatus,
} from '@dispatch/client';
import {
  AlertTriangle,
  Bot,
  Check,
  GitBranch as GitBranchIcon,
  HardDriveDownload,
  Trash2,
  Undo2,
  Waypoints,
} from 'lucide-react';

import type { ImpactSubjectRef } from '../../lib/appNav';
import { ImpactPanel } from '../impact/ImpactPanel';
import { GitDiffPane } from './GitDiffPane';
import { formatRelativeTimeFromIso } from '@/lib/format';
import { formatBytes } from '@/lib/formatBytes';
import type { BranchRowVM } from '@/lib/gitBranchRows';
import { canActOnBranchRow } from '@/lib/gitBranchRows';
import type {
  GitFileRow,
  GitRightPane as GitRightPaneState,
} from '@/lib/gitPanels';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

interface GitRightPaneProps {
  pane: GitRightPaneState;
  status: GitStatus | undefined;

  selectedFileRow: GitFileRow | undefined;
  workingDiff: string | undefined;
  workingDiffLoading: boolean;
  onToggleStageSelectedFile: () => void;
  /** Discard is only offered for unstaged/untracked/conflicted rows — a staged change has to
   * be unstaged first, same as the `d` keyboard shortcut's own guard. */
  onRequestDiscardFile: (row: GitFileRow) => void;
  /** The dispatchd client, for the selected file's Impact panel. */
  client: ApiClient | null;
  /** Navigates to `ImpactView` with the selected file preselected. */
  onOpenImpact: (subject: ImpactSubjectRef) => void;

  selectedCommit: GitLogEntry | undefined;
  commitDiff: string | undefined;
  commitDiffLoading: boolean;
  onCherryPick: (sha: string) => void;
  onRevert: (sha: string) => void;

  selectedBranch: BranchRowVM | undefined;
  onCheckout: (name: string) => void;
  onRequestDeleteBranch: (row: BranchRowVM) => void;
  onFreeDisk: (branch: string) => void;
  onDiscardRun: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onDispatchAgent: (branch: string) => void;

  selectedStash: GitStash | undefined;
  onPopStash: (index: number) => void;
  onRequestDropStash: (stash: GitStash) => void;

  busy: boolean;
}

/** The Git page's contextual right pane — what it shows is driven entirely by `pane`, derived
 * by `deriveGitRightPane` (lib/gitPanels.ts) from whichever list panel has focus. */
export function GitRightPane(props: GitRightPaneProps) {
  const { pane } = props;

  if (pane.kind === 'empty') {
    return (
      <EmptyState
        message="Nothing selected."
        className="h-full justify-center px-0 py-0 [&_[data-slot=empty-description]]:text-[12px]"
      />
    );
  }

  if (pane.kind === 'status') {
    const status = props.status;
    if (status === undefined) return null;
    return (
      <div className="flex flex-col gap-3 p-4 text-[12px]">
        <h2 className="text-[13px] font-medium">Repository status</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5">
          <dt className="text-muted-foreground">Branch</dt>
          <dd className="font-mono">{status.branch ?? 'detached HEAD'}</dd>
          <dt className="text-muted-foreground">Upstream</dt>
          <dd className="font-mono">{status.upstream ?? '—'}</dd>
          <dt className="text-muted-foreground">Ahead / behind</dt>
          <dd>
            {status.ahead} / {status.behind}
          </dd>
          <dt className="text-muted-foreground">Staged</dt>
          <dd>{status.staged.length}</dd>
          <dt className="text-muted-foreground">Unstaged</dt>
          <dd>{status.unstaged.length}</dd>
          <dt className="text-muted-foreground">Untracked</dt>
          <dd>{status.untracked.length}</dd>
          <dt className="text-muted-foreground">Conflicted</dt>
          <dd>{status.conflicted.length}</dd>
        </dl>
      </div>
    );
  }

  if (pane.kind === 'file') {
    const row = props.selectedFileRow;
    if (row === undefined) return null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shadow-hairline-bottom flex items-center justify-between gap-2 px-3 py-2">
          <span className="truncate font-mono text-[12px]">{row.path}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => props.onOpenImpact({ kind: 'file', id: row.path })}
            >
              <Waypoints className="size-3.5" />
              Open in Impact
            </Button>
            {row.section !== 'staged' && (
              <Button
                variant="ghost"
                size="xs"
                className="hover:text-destructive"
                onClick={() => props.onRequestDiscardFile(row)}
                title="Discard (d)"
              >
                <Trash2 className="size-3.5" />
                Discard
              </Button>
            )}
            <Button
              variant="outline"
              size="xs"
              onClick={props.onToggleStageSelectedFile}
            >
              {row.section === 'staged' ? 'Unstage' : 'Stage'}
            </Button>
          </div>
        </div>
        <ImpactPanel
          client={props.client}
          subject="file"
          id={row.path}
          className="m-3"
        />
        {/* A flex column so `GitDiffPane`'s `CodeView` can size itself off this with `flex-1`
            rather than a percentage — see `DiffSurface`'s `className`. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {row.section === 'untracked' ? (
            <p className="text-muted-foreground p-4 text-[12px]">
              New, untracked file — stage it to see its contents in a diff.
            </p>
          ) : (
            <GitDiffPane
              patch={props.workingDiff}
              loading={props.workingDiffLoading}
              only={row.path}
            />
          )}
        </div>
      </div>
    );
  }

  if (pane.kind === 'commit') {
    const commit = props.selectedCommit;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {commit !== undefined && (
          <div className="shadow-hairline-bottom flex items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[12px]">{commit.subject}</span>
              <span className="text-muted-foreground font-mono text-[10.5px]">
                {commit.shortSha} · {commit.author} ·{' '}
                {formatRelativeTimeFromIso(commit.date)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => props.onCherryPick(commit.sha)}
              >
                Cherry-pick
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => props.onRevert(commit.sha)}
              >
                Revert
              </Button>
            </div>
          </div>
        )}
        {/* Flex column for the same reason as the file pane's above. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <GitDiffPane
            patch={props.commitDiff}
            loading={props.commitDiffLoading}
          />
        </div>
      </div>
    );
  }

  if (pane.kind === 'branch') {
    const row = props.selectedBranch;
    if (row === undefined) return null;
    const worktree = row.worktree;
    const canAct = canActOnBranchRow(row);
    const canDiscard =
      worktree?.status === 'reviewable' && worktree.runId !== undefined;
    return (
      <div className="flex flex-col gap-3 p-4 text-[12px]">
        <div className="flex items-center gap-2">
          {row.isCurrent ? (
            <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <GitBranchIcon className="text-muted-foreground size-4" />
          )}
          <h2 className="truncate font-mono text-[13px]">{row.name}</h2>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5">
          <dt className="text-muted-foreground">Last commit</dt>
          <dd className="truncate">
            {row.shortSha} {row.subject}
          </dd>
          <dt className="text-muted-foreground">Ahead / behind</dt>
          <dd>
            {row.ahead} / {row.behind}
          </dd>
          {row.taskTitle !== undefined && (
            <>
              <dt className="text-muted-foreground">Task</dt>
              <dd className="truncate">{row.taskTitle}</dd>
            </>
          )}
          {worktree !== undefined && (
            <>
              <dt className="text-muted-foreground">Worktree</dt>
              <dd>
                {worktree.worktreeExists ? 'On disk' : 'Removed'}
                {worktree.diskBytes !== undefined && worktree.diskBytes > 0
                  ? ` · ${formatBytes(worktree.diskBytes)}`
                  : ''}
                {worktree.dirty ? ' · uncommitted changes' : ''}
              </dd>
            </>
          )}
        </dl>

        {worktree?.dirty === true && (
          <div className="bg-state-waiting-surface text-state-waiting rounded-control flex items-start gap-2 px-2.5 py-2">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>
              Uncommitted changes here block reclaiming this worktree. Commit,
              discard, or dispatch an agent to finish the work first.
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {!row.isCurrent && (
            <Button
              variant="outline"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onCheckout(row.name)}
            >
              Checkout
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onDispatchAgent(row.name)}
          >
            <Bot className="size-3.5" />
            Dispatch agent
          </Button>
          {row.runId !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.onOpenRun(row.runId)}
            >
              Open session
            </Button>
          )}
          {canAct && canDiscard && (
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onDiscardRun(worktree.runId)}
              title="Reject this work: removes the worktree and branch, and reopens the task"
            >
              <Undo2 className="size-3.5" />
              Discard
            </Button>
          )}
          {canAct && worktree?.worktreeExists === true && (
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onFreeDisk(row.name)}
              title="Delete the working copy but keep the branch"
            >
              <HardDriveDownload className="size-3.5" />
              Free disk
            </Button>
          )}
          {canAct && !row.isCurrent && (
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              className="hover:text-destructive"
              onClick={() => props.onRequestDeleteBranch(row)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
        </div>
      </div>
    );
  }

  // pane.kind === 'stash'
  const stash = props.selectedStash;
  if (stash === undefined) return null;
  return (
    <div className="flex flex-col gap-3 p-4 text-[12px]">
      <h2 className="truncate text-[13px] font-medium">{stash.message}</h2>
      <p className="text-muted-foreground">
        {formatRelativeTimeFromIso(stash.date)} · {stash.sha.slice(0, 10)}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={() => props.onPopStash(stash.index)}
        >
          <Undo2 className="size-3.5" />
          Pop
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-destructive"
          disabled={props.busy}
          onClick={() => props.onRequestDropStash(stash)}
        >
          <Trash2 className="size-3.5" />
          Drop
        </Button>
      </div>
    </div>
  );
}
