import type { FixLoopState } from '@dispatch/client';
import type { EscalationStep } from '@dispatch/core/browser';
import { Loader2, ShieldAlert, Square, Wrench } from 'lucide-react';

import type { FixLoopTone } from '../../../lib/fixLoopStatus';
import {
  fixLoopStatusLabel,
  fixLoopStopDetail,
  fixLoopTone,
  fixLoopTraceLabel,
  willEscalateNextRound,
} from '../../../lib/fixLoopStatus';
import { MainSection } from './MainSection';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

// Only a loop actually waiting on a ruling gets the "needs you" amber
// treatment; an errored one reads as a failure and the rest stay neutral.
const FIX_LOOP_TONE_CLASS: Record<FixLoopTone, string> = {
  waiting:
    'border-state-waiting-edge bg-state-waiting-surface text-state-waiting',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-border/60',
};

// What the start button offers, or null when the loop is mid-flight or done and
// pressing anything would be a no-op. A loop that stopped at its cap can still
// be nudged: a ruling on every open finding is what lets it settle.
function startAction(
  fixLoop: FixLoopState | null
): { label: string; hint: string } | null {
  if (fixLoop === null) {
    return {
      label: 'Review & fix',
      hint: 'Review the work so far and hand any findings to a fix round.',
    };
  }
  if (fixLoop.state === 'capped') {
    return {
      label: 'Continue',
      hint: 'Re-check the open findings and carry on if they have been ruled on.',
    };
  }
  return null;
}

export function FixLoopSection({
  fixLoop,
  escalation,
  onStart,
  onStop,
  starting = false,
  startError = null,
}: {
  /** `null` before any loop has been opened for this task — the button's own
   *  resting state, not an error. */
  fixLoop: FixLoopState | null;
  escalation: EscalationStep[];
  onStart: () => void;
  /** Caps the loop where it stands. Offered only while rounds are running. */
  onStop: () => void;
  starting?: boolean;
  startError?: string | null;
}) {
  const action = startAction(fixLoop);
  const stoppable =
    fixLoop !== null &&
    (fixLoop.state === 'implementing' || fixLoop.state === 'reviewing');
  const escalates =
    fixLoop !== null && willEscalateNextRound(fixLoop, escalation);
  const detail = fixLoop === null ? null : fixLoopStopDetail(fixLoop);
  const trace = fixLoop === null ? null : fixLoopTraceLabel(fixLoop);
  return (
    <MainSection title="Fix loop">
      <div
        className={cn(
          'flex flex-col gap-1 rounded-md border px-2.5 py-2 text-[13px]',
          FIX_LOOP_TONE_CLASS[
            fixLoop === null ? 'neutral' : fixLoopTone(fixLoop)
          ]
        )}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-3.5 shrink-0" />
          <span>
            {fixLoop === null
              ? 'Not started — review and fixes run when you ask for them.'
              : fixLoopStatusLabel(fixLoop)}
          </span>
          {escalates && (
            <span className="text-muted-foreground ml-auto text-[11px]">
              Next round hands off to a fresh implementer
            </span>
          )}
        </div>
        {trace !== null && (
          <p className="text-muted-foreground pl-[1.375rem] text-[12px]">
            Findings per pass: {trace}
          </p>
        )}
        {detail !== null && (
          <p className="pl-[1.375rem] text-[12px] whitespace-pre-wrap opacity-90">
            {detail}
          </p>
        )}
        {action !== null && (
          <div className="flex items-center gap-2 pt-1 pl-[1.375rem]">
            <Button
              size="xs"
              variant="outline"
              disabled={starting}
              onClick={onStart}
            >
              {starting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Wrench className="size-3" />
              )}
              {action.label}
            </Button>
            <span className="text-muted-foreground text-[11px]">
              {action.hint}
            </span>
          </div>
        )}
        {stoppable && (
          <div className="flex items-center gap-2 pt-1 pl-[1.375rem]">
            <Button size="xs" variant="outline" onClick={onStop}>
              <Square className="size-3" />
              Stop
            </Button>
            <span className="text-muted-foreground text-[11px]">
              Cap the loop here; Review &amp; fix resumes it later.
            </span>
          </div>
        )}
        {startError !== null && (
          <p className="text-destructive pl-[1.375rem] text-[12px]">
            {startError}
          </p>
        )}
      </div>
    </MainSection>
  );
}
