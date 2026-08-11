import type { PrCheckSummary } from '@dispatch/client';
import { Check, Clock, ExternalLink, X } from 'lucide-react';

import { PrChecksPill } from '../runs/PrStatusPills';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

interface ChecksPopoverProps {
  checks: PrCheckSummary;
  /** The PR's GitHub URL, for the "view checks" link — absent for a
   * queue-local row that has no PR yet, in which case the popover has
   * nothing to link out to. */
  url?: string;
}

/**
 * The Checks cell: `PrChecksPill`'s rollup, expandable into a popover with the
 * passed/failed/pending breakdown and a link out to GitHub's own checks tab.
 *
 * The server only ever hands the client a `PrCheckSummary` — pass/fail/pending
 * counts reduced from `gh`'s `statusCheckRollup` (see `summarizeChecks` in
 * packages/server/src/orchestrator/pr.ts). Per-run name/conclusion/URL never
 * reaches here, so this popover expands the rollup it actually has rather than
 * listing named check runs; a named list would need a server-side change this
 * task's scope doesn't cover.
 */
export function ChecksPopover({ checks, url }: ChecksPopoverProps) {
  if (checks.total === 0) {
    return <span className="dense-meta text-muted-foreground">no CI</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="cursor-pointer">
          <PrChecksPill checks={checks} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3">
        <div className="flex flex-col gap-1.5 text-[12px]">
          <div className="text-state-review flex items-center gap-1.5">
            <Check className="size-3.5" />
            {checks.passed} passed
          </div>
          {checks.failed > 0 && (
            <div className="text-destructive flex items-center gap-1.5">
              <X className="size-3.5" />
              {checks.failed} failed
            </div>
          )}
          {checks.pending > 0 && (
            <div className="text-state-waiting flex items-center gap-1.5">
              <Clock className="size-3.5" />
              {checks.pending} running
            </div>
          )}
          {url !== undefined && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-[11px]"
            >
              View checks on GitHub
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
