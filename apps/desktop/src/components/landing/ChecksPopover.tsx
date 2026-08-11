import type { PrCheckRun, PrCheckSummary } from '@dispatch/client';
import { Check, Clock, ExternalLink, X } from 'lucide-react';

import { PrChecksPill } from '../runs/PrStatusPills';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

interface ChecksPopoverProps {
  checks: PrCheckSummary;
  /** The PR's GitHub URL, for the aggregate-only fallback's "view checks"
   * link — absent for a queue-local row that has no PR yet. */
  url?: string;
}

// Buckets a check's conclusion the same way the server's `summarizeChecks`
// does, so a check's dot tone always agrees with the aggregate line above it.
type RunBucket = 'passed' | 'failed' | 'pending';

const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
]);

function runBucket(conclusion: string): RunBucket {
  const upper = conclusion.toUpperCase();
  if (PASSED_CONCLUSIONS.has(upper)) return 'passed';
  if (FAILED_CONCLUSIONS.has(upper)) return 'failed';
  return 'pending';
}

// Same three tones as `PrChecksPill`/the breakdown below, as a dot fill so
// many checks stay scannable in one column instead of full pills.
const BUCKET_DOT_CLASS: Record<RunBucket, string> = {
  passed: 'bg-state-review',
  failed: 'bg-destructive',
  pending: 'bg-state-waiting',
};

function CheckRunRow({ run }: { run: PrCheckRun }) {
  const bucket = runBucket(run.conclusion);
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          BUCKET_DOT_CLASS[bucket]
        )}
      />
      <span className="min-w-0 flex-1 truncate">{run.name}</span>
      <span className="dense-meta shrink-0 lowercase">
        {run.conclusion.toLowerCase()}
      </span>
      {run.url !== '' && (
        <a
          href={run.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${run.name} on GitHub`}
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

/** The Checks cell: `PrChecksPill`'s rollup, expanding into a popover of named
 * checks — or, when `runs` is empty (an older daemon), the aggregate only. */
export function ChecksPopover({ checks, url }: ChecksPopoverProps) {
  if (checks.total === 0) {
    return <span className="dense-meta text-muted-foreground">no CI</span>;
  }

  const hasNamedRuns = checks.runs.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="cursor-pointer">
          <PrChecksPill checks={checks} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
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

          {hasNamedRuns ? (
            <div className="border-border mt-1 flex max-h-48 flex-col gap-1.5 overflow-y-auto border-t pt-1.5">
              {checks.runs.map((run, i) => (
                // Names aren't guaranteed unique; index is stable for this list's lifetime.
                <CheckRunRow key={`${run.name}-${i}`} run={run} />
              ))}
            </div>
          ) : (
            url !== undefined && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-[11px]"
              >
                View checks on GitHub
                <ExternalLink className="size-3" />
              </a>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
