import type {
  ApiClient,
  GateStatus,
  LandingRow as LandingRowData,
  PrCheckSummary,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  FolderOpen,
  MoreHorizontal,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

import { landingKey } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import { gateChipLabel, relativeTime } from '../../lib/landingView';
import {
  isRetryable,
  phaseSteps,
  queueStateLabel,
} from '../../lib/mergeQueueView';
import { openInEditor, revealInFinder } from '../../lib/tauri';
import { ForkConfirm } from '../runs/PrReviewPanel';
import { REVIEW_VERDICT, StatusPill } from '../runs/PrStatusPills';
import { useToasts } from '../shell/Toasts';
import { ChecksPopover } from './ChecksPopover';
import { Button } from '@/ui/button';
import { StepStrip } from '@/ui/chrome/StepStrip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { TableCell, TableRow } from '@/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

// A row with no PR has no `checks` — distinct from a real zero-check PR,
// which `ChecksPopover` already renders correctly on its own.
const NO_CHECKS: PrCheckSummary = {
  passed: 0,
  failed: 0,
  pending: 0,
  total: 0,
  runs: [],
};

// The status dot's fill, keyed off the gate rather than the row's group —
// two gates in the same group still read by their own run-state color family.
const GATE_COLOR: Record<GateStatus, string> = {
  ready: 'var(--state-review-fg)',
  'waiting-checks': 'var(--state-waiting-fg)',
  'waiting-review': 'var(--state-waiting-fg)',
  conflicts: 'var(--state-failed-fg)',
  draft: 'var(--state-blocked-fg)',
  'queue-position': 'var(--state-landing-fg)',
  verifying: 'var(--state-working-fg)',
  merging: 'var(--state-working-fg)',
  blocked: 'var(--state-waiting-fg)',
  none: 'var(--state-ready-fg)',
};

/** A run-backed row opens its task's Diff tab; a bare PR row opens the PR
 * review page. `null` only for a malformed row that is neither. */
function openRowTarget(
  row: LandingRowData,
  onOpenRun: (taskId: string, runId: string) => void,
  onOpenPr: (number: number) => void
): (() => void) | null {
  const { taskId, runId, pr } = row;
  if (taskId !== undefined && runId !== undefined) {
    return () => onOpenRun(taskId, runId);
  }
  if (pr !== undefined) return () => onOpenPr(pr.number);
  return null;
}

interface LandingRowProps {
  row: LandingRowData;
  /** Every row currently in the queue — `gateChipLabel`'s "#3 · behind X"
   * needs the whole set to name the entry one ahead. */
  queueRows: readonly LandingRowData[];
  now: number;
  onFilterAuthor: (author: string) => void;
  onFilterGate: (gate: GateStatus) => void;
  /** Opens the run's work in its task view — App.tsx routes this to the task's
   * Diff tab, pinned to this run. */
  onOpenRun: (taskId: string, runId: string) => void;
  /** Opens a PR with no run behind it in the full-window PR review page. */
  onOpenPr: (number: number) => void;
  client: ApiClient | null;
  port: number | undefined;
  /** Rechecks the whole queue — the fix for a `blocked-environment` hold is a
   * property of the shared checkout, not of one entry, so there is only ever
   * this one queue-wide action behind every held row's Retry button. */
  onRetryQueue: () => Promise<void>;
}

/** One row of the unified PR table: status dot, title + identity subline,
 * landing progress, checks, diffstat, review verdict, and worktree. */
export function LandingRow({
  row,
  queueRows,
  now,
  onFilterAuthor,
  onFilterGate,
  onOpenRun,
  onOpenPr,
  client,
  port,
  onRetryQueue,
}: LandingRowProps) {
  const { pr, queue } = row;
  const openTarget = openRowTarget(row, onOpenRun, onOpenPr);
  const color = GATE_COLOR[row.gate.status];
  const steps =
    queue !== undefined
      ? phaseSteps(queue.entry.state, queue.entry.steps)
      : null;
  const verdict =
    pr?.reviewDecision === 'APPROVED'
      ? REVIEW_VERDICT.APPROVED
      : pr?.reviewDecision === 'CHANGES_REQUESTED'
        ? REVIEW_VERDICT.CHANGES_REQUESTED
        : undefined;

  return (
    <TableRow>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{
                backgroundColor: color,
                boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 16%, transparent)`,
              }}
            />
          </TooltipTrigger>
          <TooltipContent>{row.gate.detail}</TooltipContent>
        </Tooltip>
      </TableCell>

      <TableCell className="max-w-[360px]">
        <button
          type="button"
          disabled={openTarget === null}
          onClick={() => openTarget?.()}
          className="block max-w-full truncate text-left text-[13px] hover:underline"
        >
          {row.title}
        </button>
        <div className="dense-meta mt-0.5 flex min-w-0 items-center gap-1 truncate">
          {pr !== undefined ? (
            <>
              <span>#{pr.number}</span>
              <span>·</span>
              <button
                type="button"
                onClick={() => onFilterAuthor(pr.author)}
                className="hover:text-foreground"
              >
                {pr.author}
              </button>
              <span>·</span>
              <span className="min-w-0 truncate">
                {pr.headRefName} → {pr.baseRefName}
              </span>
              <span>·</span>
              <span className="shrink-0">
                {relativeTime(pr.updatedAt, now)}
              </span>
            </>
          ) : queue !== undefined ? (
            <>
              <span>{queueStateLabel(queue.entry.state)}</span>
              <span>·</span>
              <span>
                {relativeTime(
                  queue.entry.stateSince ?? queue.entry.enqueuedAt,
                  now
                )}
              </span>
            </>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="max-w-[200px]">
        <button
          type="button"
          onClick={() => onFilterGate(row.gate.status)}
          className="dense-meta hover:text-foreground block max-w-full truncate text-left"
        >
          {gateChipLabel(row, queueRows)}
        </button>
        {steps !== null && <StepStrip steps={steps} className="mt-1.5 w-24" />}
        {queue !== undefined && isRetryable(queue.entry.state) && (
          <QueueRetryButton onRetry={onRetryQueue} />
        )}
      </TableCell>

      <TableCell className="hidden md:table-cell">
        <ChecksPopover checks={pr?.checks ?? NO_CHECKS} url={pr?.url} />
      </TableCell>

      <TableCell className="hidden sm:table-cell">
        {pr !== undefined ? (
          <div className="flex flex-col">
            <span className="dense-meta">
              <span className="text-state-review">+{pr.additions}</span>{' '}
              <span className="text-destructive">−{pr.deletions}</span>
            </span>
            <span className="dense-meta text-muted-foreground">
              {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
            </span>
          </div>
        ) : (
          <span className="dense-meta text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="hidden md:table-cell">
        {verdict !== undefined ? (
          <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
        ) : (
          <span className="dense-meta text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell>
        <WorktreeCell row={row} client={client} port={port} />
      </TableCell>
    </TableRow>
  );
}

/** The retry action for a row parked on `blocked-environment` — the only
 * held state a person can act on (see `isRetryable`). Restores the affordance
 * `POST /api/merge-queue/recheck` lost when the old Landing view was
 * replaced by this table. */
function QueueRetryButton({ onRetry }: { onRetry: () => Promise<void> }) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      await onRetry();
    } catch (err) {
      toasts.push({
        title: "Couldn't recheck the merge queue",
        description: describeError(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => void retry()}
      className="mt-1.5"
    >
      Retry
    </Button>
  );
}

const SYNC_STATE_LABEL: Record<
  NonNullable<LandingRowData['worktree']>['syncState'],
  { label: string; tone: 'green' | 'amber' | 'red' }
> = {
  synced: { label: 'synced', tone: 'green' },
  behind: { label: 'behind', tone: 'amber' },
  'dirty-hold': { label: 'dirty · hold', tone: 'red' },
};

/** The Worktree cell: cuts/removes a review worktree for a PR row, or shows
 * its sync state + actions menu once one exists. No PR ⇒ a bare dash. */
function WorktreeCell({
  row,
  client,
  port,
}: {
  row: LandingRowData;
  client: ApiClient | null;
  port: number | undefined;
}) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  // Local, not shared: a stale confirm must never linger under a different
  // row's "Check out" button once the queue re-sorts.
  const [askingFork, setAskingFork] = useState(false);

  const pr = row.pr;
  const worktree = row.worktree;

  async function checkout(confirmFork: boolean) {
    if (client === null || pr === undefined) return;
    setBusy(true);
    try {
      await client.createPrWorktree(pr.number, { confirmFork });
      setAskingFork(false);
      void queryClient.invalidateQueries({ queryKey: landingKey(port) });
    } catch (err) {
      setAskingFork(false);
      toasts.push({
        title: `Couldn't check out #${pr.number}`,
        description: describeError(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (client === null || pr === undefined) return;
    setBusy(true);
    try {
      await client.removePrWorktree(pr.number);
      void queryClient.invalidateQueries({ queryKey: landingKey(port) });
    } catch (err) {
      // A dirty worktree 409s with the reason in the message — surfaced via
      // the same toast every other worktree failure here uses, per spec.
      toasts.push({
        title: `Couldn't remove the worktree for #${pr.number}`,
        description: err instanceof ApiError ? err.message : describeError(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  if (pr === undefined) {
    return <span className="dense-meta text-muted-foreground">—</span>;
  }

  if (worktree === undefined) {
    return (
      <Popover
        open={askingFork}
        onOpenChange={(open) => {
          if (!open) setAskingFork(false);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={client === null || busy}
            onClick={() => {
              if (pr.isCrossRepository) setAskingFork(true);
              else void checkout(false);
            }}
          >
            Check out
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <ForkConfirm
            owner={pr.headRepositoryOwner}
            busy={busy}
            onCancel={() => setAskingFork(false)}
            onConfirm={() => void checkout(true)}
          />
        </PopoverContent>
      </Popover>
    );
  }

  const sync = SYNC_STATE_LABEL[worktree.syncState];

  return (
    <div className="flex items-center gap-1">
      <StatusPill tone={sync.tone}>{sync.label}</StatusPill>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Worktree actions for #${pr.number}`}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              openInEditor(worktree.path).catch((err: unknown) => {
                console.error(`Failed to open ${worktree.path}:`, err);
              });
            }}
          >
            <SquareArrowOutUpRight className="size-3.5" />
            Open in editor
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard
                ?.writeText(worktree.path)
                .catch(() => undefined);
            }}
          >
            <Copy className="size-3.5" />
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              revealInFinder(worktree.path).catch((err: unknown) => {
                console.error(`Failed to reveal ${worktree.path}:`, err);
              });
            }}
          >
            <FolderOpen className="size-3.5" />
            Reveal
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onSelect={() => void remove()}
          >
            <Trash2 className="size-3.5" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
