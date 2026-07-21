import type { RunMeta } from '@dispatch/client';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { modelLabel } from '../../lib/models';
import { RunStatePill } from './RunStatePill';
import { Button } from '@/ui/button';

interface RunDetailHeaderProps {
  meta: RunMeta;
  /** The cost figure to show, already resolved by the caller (`liveCostUsd`) — `null` when
   * nothing is known yet. Kept as a plain prop rather than computed in here so this header
   * doesn't need its own copy of the run's log entries just to derive a number RunsView
   * already has. */
  cost: number | null;
  /** Whether this run can still be cancelled — true for `provisioning`/`running`/
   * `awaiting-approval`, matching the old per-tab header's own `live` check. */
  live: boolean;
  onCancel: () => Promise<void>;
}

/**
 * One header row shared by both the Session and Diff tabs (rendered once, above the `Tabs`,
 * per the redesign brief's "keep the live cost/state header row above the tabs") — state pill,
 * branch, running cost/turns, a terminal run's error or PR-opened chip, and Cancel while the
 * run is still live. Replaces the near-duplicate header rows `RunLogView` and `RunReviewView`
 * used to render independently, which disagreed on layout and went out of sync with whichever
 * tab happened to be selected.
 */
export function RunDetailHeader({
  meta,
  cost,
  live,
  onCancel,
}: RunDetailHeaderProps) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCancel() {
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <RunStatePill state={meta.state} />
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
            className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-600 transition-colors duration-150 hover:bg-blue-500/20 dark:text-blue-400"
            href={meta.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            PR opened
            <ExternalLink className="size-3" />
          </a>
        )}
        <div className="flex-1" />
        {live && (
          <Button
            variant="ghost"
            size="sm"
            disabled={cancelling}
            onClick={() => void submitCancel()}
          >
            Cancel
          </Button>
        )}
      </div>
      {error !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
          {error}
        </div>
      )}
    </div>
  );
}
