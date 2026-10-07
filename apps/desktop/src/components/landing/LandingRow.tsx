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
import type { MouseEvent } from 'react';
import { useState } from 'react';

import { landingKey } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import { checklistLabel } from '../../lib/judgmentBadges';
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
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { ListRow } from '@/ui/ai/list-row';
import { LabelPill, PillButton } from '@/ui/ai/pill';
import { StepStrip } from '@/ui/chrome/StepStrip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
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

// The gate pill's dot, keyed off the gate rather than the row's group —
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

const META_CLASS = 'text-[12px] font-book text-muted-foreground tabular-nums';

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
  /** How many older runs this task's surviving row also speaks for. */
  extraRuns?: number;
  /** The run's reviewedAt — fills the review pill for queue-local rows. */
  reviewedAt?: string;
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

/** One 36px row of the unified PR table: the PR number, the title, then the
 * right-aligned gate pill, landing progress, checks, diffstat, review verdict,
 * worktree, the author's avatar and when it last moved. */
export function LandingRow({
  row,
  queueRows,
  now,
  extraRuns,
  reviewedAt,
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

  // The identity subline the table used to carry — branch → base, the queue
  // state, extra runs — folded into the title's crumb so the row stays one line.
  const crumb =
    pr !== undefined
      ? `${pr.headRefName} → ${pr.baseRefName}`
      : queue !== undefined
        ? queueStateLabel(queue.entry.state, queue.entry.landedOn)
        : undefined;
  const crumbWithRuns =
    extraRuns !== undefined && extraRuns > 0
      ? `${crumb !== undefined ? `${crumb} · ` : ''}×${extraRuns + 1} runs`
      : crumb;

  const movedAt =
    pr !== undefined
      ? pr.updatedAt
      : queue !== undefined
        ? (queue.entry.stateSince ?? queue.entry.enqueuedAt)
        : undefined;

  // The whole row opens the target, except a click on one of its own controls — the
  // gate pill, the checks popover, the worktree menu, the avatar — or inside a popover
  // those controls portal out of the row (React bubbles through portals; the DOM does not).
  const openRow =
    openTarget === null
      ? undefined
      : (event?: MouseEvent<HTMLDivElement>) => {
          if (event !== undefined) {
            const target = event.target as Node;
            if (!event.currentTarget.contains(target)) return;
            if (
              target instanceof Element &&
              target.closest('[data-row-action]') !== null
            ) {
              return;
            }
          }
          openTarget();
        };

  return (
    <ListRow
      data-landing-row={row.id}
      role="listitem"
      id={pr !== undefined ? `#${pr.number}` : undefined}
      title={row.title}
      crumb={crumbWithRuns}
      onClick={openRow}
      trailing={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-row-action
                  className="rounded-pill focus-visible:ring-ring flex shrink-0 items-center outline-none focus-visible:ring-2"
                  onClick={() => onFilterGate(row.gate.status)}
                />
              }
            >
              <LabelPill
                color={color}
                className="hover:bg-surface-active cursor-pointer"
              >
                {gateChipLabel(row, queueRows)}
              </LabelPill>
            </TooltipTrigger>
            <TooltipContent>{row.gate.detail}</TooltipContent>
          </Tooltip>
          {steps !== null && <StepStrip steps={steps} className="w-20" />}
          {checklistLabel(row.checklist) !== null && (
            <LabelPill
              color={
                (row.checklist?.weak.length ?? 0) > 0
                  ? 'var(--state-waiting-fg)'
                  : 'var(--muted-foreground)'
              }
              title={
                (row.checklist?.weak.length ?? 0) > 0
                  ? `Weak: ${row.checklist?.weak.join(' · ')}`
                  : undefined
              }
            >
              {checklistLabel(row.checklist)}
            </LabelPill>
          )}
          {queue !== undefined && isRetryable(queue.entry.state) && (
            <span data-row-action>
              <QueueRetryButton onRetry={onRetryQueue} />
            </span>
          )}
          {pr !== undefined && (
            <span data-row-action>
              <ChecksPopover checks={pr.checks ?? NO_CHECKS} url={pr.url} />
            </span>
          )}
          {pr !== undefined && (
            <span className={cn(META_CLASS, 'hidden sm:inline')}>
              <span className="text-state-review">+{pr.additions}</span>{' '}
              <span className="text-state-failed">−{pr.deletions}</span>
            </span>
          )}
          {verdict !== undefined ? (
            <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
          ) : reviewedAt !== undefined ? (
            <StatusPill tone="green">Reviewed</StatusPill>
          ) : null}
          {pr !== undefined && (
            <span data-row-action>
              <WorktreeCell row={row} client={client} port={port} />
            </span>
          )}
          {pr !== undefined && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-row-action
                    aria-label={`Filter by author ${pr.author}`}
                    className="rounded-pill focus-visible:ring-ring flex shrink-0 items-center outline-none focus-visible:ring-2"
                    onClick={() => onFilterAuthor(pr.author)}
                  />
                }
              >
                <InitialsAvatar name={pr.author} />
              </TooltipTrigger>
              <TooltipContent>{pr.author}</TooltipContent>
            </Tooltip>
          )}
        </>
      }
      date={movedAt !== undefined ? relativeTime(movedAt, now) : undefined}
    />
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
    <PillButton disabled={busy} onClick={() => void retry()}>
      Retry
    </PillButton>
  );
}

const SYNC_STATE_LABEL: Record<
  NonNullable<LandingRowData['worktree']>['syncState'],
  { label: string; tone: 'green' | 'amber' | 'red' }
> = {
  synced: { label: 'Synced', tone: 'green' },
  behind: { label: 'Behind', tone: 'amber' },
  'dirty-hold': { label: 'Dirty · hold', tone: 'red' },
};

/** The worktree slot: cuts/removes a review worktree for a PR row, or shows
 * its sync state + actions menu once one exists. */
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

  if (pr === undefined) return null;

  if (worktree === undefined) {
    return (
      <Popover
        open={askingFork}
        onOpenChange={(open) => {
          if (!open) setAskingFork(false);
        }}
      >
        <PopoverTrigger
          render={
            <PillButton
              disabled={client === null || busy}
              onClick={() => {
                if (pr.isCrossRepository) setAskingFork(true);
                else void checkout(false);
              }}
            />
          }
        >
          Check out
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
    <span className="flex items-center gap-1">
      <StatusPill tone={sync.tone}>{sync.label}</StatusPill>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<IconButton label={`Worktree actions for #${pr.number}`} />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              openInEditor(worktree.path).catch((err: unknown) => {
                console.error(`Failed to open ${worktree.path}:`, err);
              });
            }}
          >
            <SquareArrowOutUpRight />
            Open in editor
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              void navigator.clipboard
                ?.writeText(worktree.path)
                .catch(() => undefined);
            }}
          >
            <Copy />
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              revealInFinder(worktree.path).catch((err: unknown) => {
                console.error(`Failed to reveal ${worktree.path}:`, err);
              });
            }}
          >
            <FolderOpen />
            Reveal
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
