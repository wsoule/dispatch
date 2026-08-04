import type { RunMeta } from '@dispatch/client';
import { ExternalLink, Layers2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { modelLabel } from '../../lib/models';
import { deriveStopControl } from '../../lib/runState';
import { RunKindBadge } from './RunKindBadge';
import { RunStatePill } from './RunStatePill';
import { Button } from '@/ui/button';

interface RunDetailHeaderProps {
  meta: RunMeta;
  /** The cost figure to show, already resolved by the caller (`liveCostUsd`) — `null` when
   * nothing is known yet. Kept as a plain prop rather than computed in here so this header
   * doesn't need its own copy of the run's log entries just to derive a number RunsView
   * already has. */
  cost: number | null;
  onCancel: () => Promise<void>;
  /** Asks the agent to wind down: it finishes what it is doing, then stops, and its
   * work is committed and reviewable. `onCancel` is the hard form that kills it where
   * it stands and leaves uncommitted work loose in the worktree. */
  onStop: () => Promise<void>;
  /** Controls that belong on this row rather than on a row of their own — the
   * Session/Diff switch and the run's own actions. Passed in so the header
   * stays one line instead of the view stacking a toolbar under it. */
  trailing?: React.ReactNode;
}

/**
 * One header row shared by both the Session and Diff tabs (rendered once, above the `Tabs`,
 * per the redesign brief's "keep the live cost/state header row above the tabs") — state pill,
 * branch, running cost/turns, a terminal run's error or PR-opened chip, a "stacked on" chip
 * naming the blocker branch(es) this run's worktree was branched from, a discarded-base warning
 * once that blocker gets rejected, and Cancel while the run is still live. Replaces the
 * near-duplicate header rows `RunLogView` and `RunReviewView` used to render independently,
 * which disagreed on layout and went out of sync with whichever tab happened to be selected.
 *
 * A live run gets both halting controls, because they do genuinely different things: Stop asks
 * the agent to finish its current operation and wind down (its work is committed and stays
 * reviewable), Cancel kills the session immediately (uncommitted work is left loose in the
 * worktree). Cancel stays enabled while a stop is in flight — it is the escape hatch for an
 * agent taking too long to wind down.
 */
export function RunDetailHeader({
  meta,
  cost,
  onCancel,
  onStop,
  trailing,
}: RunDetailHeaderProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the halting controls show at all, and how Stop reads, both come
  // from the run's own state and marker rather than local click state or a
  // caller-supplied flag — see deriveStopControl.
  const stop = deriveStopControl(meta);

  async function submit(action: () => Promise<void>) {
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

  return (
    <div className="flex flex-col gap-2">
      {/* Wraps rather than clips. The metadata chips on the left and the
          controls on the right together outgrow a narrow detail pane, and a
          single non-wrapping row silently cut the rightmost control off the
          edge — a Cancel button you cannot see or click. With `flex-wrap` plus
          `ml-auto` on the control cluster, the row stays one line and
          right-aligned whenever it fits, and drops the controls to a second
          line instead of hiding them when it doesn't. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <RunStatePill meta={meta} />
        <RunKindBadge kind={meta.kind} />
        {meta.branch !== undefined && (
          <span className="text-muted-foreground truncate font-mono text-[11px]">
            {meta.branch}
          </span>
        )}
        {meta.model !== undefined && (
          <span className="border-border text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-[11px]">
            {modelLabel(meta.model)}
          </span>
        )}
        {cost !== null && (
          <span className="text-muted-foreground font-mono text-[12px]">
            ${cost.toFixed(2)}
          </span>
        )}
        {meta.turns !== undefined && (
          <span className="text-muted-foreground text-[11px]">
            {meta.turns} turns
          </span>
        )}
        {meta.error !== undefined && (
          <span className="text-destructive truncate text-[12px]">
            {meta.error}
          </span>
        )}
        {meta.prUrl !== undefined && (
          <a
            className="border-state-landing-edge bg-state-landing-surface text-state-landing hover:bg-state-landing-surface/70 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-150"
            href={meta.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            PR opened
            <ExternalLink className="size-3" />
          </a>
        )}
        {meta.stackParents !== undefined && meta.stackParents.length > 0 && (
          <span
            className="border-border text-muted-foreground inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
            title={meta.stackParents.join(', ')}
          >
            <Layers2 className="size-3 shrink-0" />
            <span className="truncate">
              stacked on{' '}
              {meta.stackParents.length === 1
                ? meta.stackParents[0]
                : `${meta.stackParents.length} branches`}
            </span>
          </span>
        )}
        {/* `baseDiscarded` is raised for three different reasons and only one
            of them is an actually-discarded base — the other two are a failed
            restack and an unrepairable multi-parent base, where the base
            merged perfectly well. Show the reason the server recorded rather
            than fixed copy that is wrong two times out of three; the generic
            fallback only applies to a run flagged before the reason was
            persisted. */}
        {meta.baseDiscarded === true && (
          <span
            className="border-destructive/30 bg-destructive/10 text-destructive inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
            title={meta.baseDiscardedReason}
          >
            <TriangleAlert className="size-3 shrink-0" />
            <span className="truncate">
              {meta.baseDiscardedReason ??
                'base discarded — rebase before merging'}
            </span>
          </span>
        )}
        {/* A terminal run that carries the marker ended because someone asked it
            to, not because it ran out of work — worth saying, since "Finished"
            alone would read as a run that completed its task. */}
        {stop.showStoppedChip && (
          <span
            className="border-border text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-[11px]"
            title={`Stop requested at ${meta.stopRequestedAt}`}
          >
            Stopped
          </span>
        )}
        {/* One cluster, so the tab switch and the halting controls wrap together
            rather than splitting across two lines mid-group. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {trailing}
          {stop.showButtons && (
            <Button
              variant="secondary"
              size="sm"
              // Already-stopping stays visible rather than disappearing: it is
              // the status line for a run that is still working, and swapping it
              // for Cancel alone would look like the stop had been forgotten.
              disabled={busy || stop.stopDisabled}
              title={
                stop.stopDisabled
                  ? 'Already stopping — the agent is finishing its current operation'
                  : 'Let the agent finish its current operation, then stop and keep its work'
              }
              onClick={() => void submit(onStop)}
            >
              {stop.stopLabel}
            </Button>
          )}
          {stop.showButtons && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title="Stop immediately, without letting the agent finish or commit"
              onClick={() => void submit(onCancel)}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      {error !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
          {error}
        </div>
      )}
    </div>
  );
}
