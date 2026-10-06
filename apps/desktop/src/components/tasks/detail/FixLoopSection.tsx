import type { EscalationStep } from '@dispatch-foo/core/browser';
import type { FixLoopState } from '@dispatch/client';
import { Loader2, ShieldAlert, Square, Wrench } from 'lucide-react';

import type { FixLoopTone } from '../../../lib/fixLoopStatus';
import {
  fixLoopStatusLabel,
  fixLoopStopDetail,
  fixLoopTint,
  fixLoopTone,
  fixLoopTraceLabel,
  willEscalateNextRound,
} from '../../../lib/fixLoopStatus';
import { MainSection } from './MainSection';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { PillButton } from '@/ui/ai/pill';

// The bar's glyph takes the tone colour; the bar itself stays a neutral group
// header whose left edge picks up the same tint.
const FIX_LOOP_ICON_CLASS: Record<FixLoopTone, string> = {
  waiting: 'text-state-waiting',
  failed: 'text-red',
  neutral: 'text-muted-foreground',
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

// The fix loop as a 36px group-header bar — glyph, status line, pill buttons at
// the right — with the trace, stop detail, hints and errors as muted 12px lines
// beneath it.
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
  const tone = fixLoop === null ? 'neutral' : fixLoopTone(fixLoop);
  const hasLines =
    escalates ||
    trace !== null ||
    detail !== null ||
    action !== null ||
    stoppable ||
    startError !== null;
  return (
    <MainSection title="Fix loop">
      <div className="flex flex-col gap-1.5">
        <GroupHeader
          tint={fixLoopTint(tone)}
          icon={
            <ShieldAlert
              aria-hidden
              className={cn('size-3.5', FIX_LOOP_ICON_CLASS[tone])}
            />
          }
          name={
            fixLoop === null
              ? 'Not started — review and fixes run when you ask for them.'
              : fixLoopStatusLabel(fixLoop)
          }
          actions={
            <>
              {action !== null && (
                <PillButton disabled={starting} onClick={onStart}>
                  {starting ? <Loader2 className="animate-spin" /> : <Wrench />}
                  {action.label}
                </PillButton>
              )}
              {stoppable && (
                <PillButton onClick={onStop}>
                  <Square />
                  Stop
                </PillButton>
              )}
            </>
          }
        />
        {hasLines && (
          <div className="text-muted-foreground font-book flex flex-col gap-0.5 px-2 text-[12px]">
            {escalates && <p>Next round hands off to a fresh implementer.</p>}
            {trace !== null && <p>Findings per pass: {trace}</p>}
            {detail !== null && (
              <p className="whitespace-pre-wrap text-(--text-secondary)">
                {detail}
              </p>
            )}
            {action !== null && <p>{action.hint}</p>}
            {stoppable && (
              <p>Stop caps the loop here; Review &amp; fix resumes it later.</p>
            )}
            {startError !== null && <p className="text-red">{startError}</p>}
          </div>
        )}
      </div>
    </MainSection>
  );
}
