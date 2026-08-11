import type { VerificationResult } from '@dispatch/client';
import { FlaskConical } from 'lucide-react';

import { revealInFinder } from '../../../lib/tauri';
import {
  summarizeVerification,
  verificationCheckDetail,
} from '../../../lib/verificationSummary';
import { MainSection } from './MainSection';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

// `exercised` stays visually distinct from review status; self-hides when
// there is nothing to say (never exercised, no result, no error).
export function VerificationSection({
  exercised,
  result,
  error,
}: {
  exercised: boolean;
  result: VerificationResult | null;
  /** Set when the checks fetch itself failed — distinct from `result` being
   * `null` because nothing has ever run, which is not an error at all. */
  error: string | null;
}) {
  if (!exercised && result === null && error === null) return null;
  const summary = summarizeVerification(result);
  return (
    <MainSection title="Verification">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[13px]">
          <FlaskConical
            className={cn(
              'size-3.5',
              exercised ? 'text-state-review' : 'text-muted-foreground'
            )}
          />
          <span
            className={
              exercised
                ? 'text-state-review font-medium'
                : 'text-muted-foreground'
            }
          >
            {exercised ? 'Exercised' : 'Not exercised'}
          </span>
          {error === null ? (
            <span className="text-muted-foreground text-[12px]">
              · {summary.label}
            </span>
          ) : (
            <span className="text-destructive text-[12px]">
              · couldn&rsquo;t load checks
            </span>
          )}
        </div>
        {error !== null && (
          <div className="text-destructive text-[12px]">{error}</div>
        )}
        {result !== null && result.checks.length > 0 && (
          <ul className="flex flex-col gap-1">
            {result.checks.map((check, i) => {
              const detail = verificationCheckDetail(check);
              return (
                <li key={i} className="text-[12px]">
                  <span
                    className={
                      check.pass ? 'text-state-review' : 'text-state-failed'
                    }
                  >
                    {check.pass ? '✓' : '✗'}
                  </span>{' '}
                  <span className="text-foreground/90">{check.check}</span>
                  {detail !== null && (
                    <dl className="text-muted-foreground mt-0.5 ml-[1.1rem] grid grid-cols-[4rem_1fr] gap-x-2 text-[11.5px]">
                      <dt>Expected</dt>
                      <dd className="text-foreground/80 break-words">
                        {detail.expected}
                      </dd>
                      <dt>Actual</dt>
                      <dd className="text-state-failed break-words">
                        {detail.actual}
                      </dd>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {result !== null && result.artifacts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {result.artifacts.map((path) =>
              path.startsWith('/') ? (
                <Button
                  key={path}
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    revealInFinder(path).catch((err: unknown) => {
                      console.error(`Failed to reveal ${path}:`, err);
                    });
                  }}
                  title={path}
                  className="border-border/60 text-muted-foreground hover:text-foreground h-auto max-w-full min-w-0 justify-start rounded border px-1.5 py-0.5 text-left font-mono text-[11px] break-all whitespace-normal hover:bg-transparent"
                >
                  {path}
                </Button>
              ) : (
                <span
                  key={path}
                  title={path}
                  className="text-muted-foreground max-w-full min-w-0 rounded border border-transparent px-1.5 py-0.5 font-mono text-[11px] break-all"
                >
                  {path}
                </span>
              )
            )}
          </div>
        )}
      </div>
    </MainSection>
  );
}
