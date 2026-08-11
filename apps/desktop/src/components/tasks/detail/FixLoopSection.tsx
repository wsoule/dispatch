import type { FixLoopState } from '@dispatch/client';
import type { EscalationStep } from '@dispatch/core/browser';
import { ShieldAlert } from 'lucide-react';

import type { FixLoopTone } from '../../../lib/fixLoopStatus';
import {
  fixLoopStatusLabel,
  fixLoopStopDetail,
  fixLoopTone,
  willEscalateNextRound,
} from '../../../lib/fixLoopStatus';
import { MainSection } from './MainSection';
import { cn } from '@/lib/utils';

// Only a loop actually waiting on a ruling gets the "needs you" amber
// treatment; an errored one reads as a failure and the rest stay neutral.
const FIX_LOOP_TONE_CLASS: Record<FixLoopTone, string> = {
  waiting:
    'border-state-waiting-edge bg-state-waiting-surface text-state-waiting',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-border/60',
};

export function FixLoopSection({
  fixLoop,
  escalation,
}: {
  fixLoop: FixLoopState;
  escalation: EscalationStep[];
}) {
  const escalates = willEscalateNextRound(fixLoop, escalation);
  const detail = fixLoopStopDetail(fixLoop);
  return (
    <MainSection title="Fix loop">
      <div
        className={cn(
          'flex flex-col gap-1 rounded-md border px-2.5 py-2 text-[13px]',
          FIX_LOOP_TONE_CLASS[fixLoopTone(fixLoop)]
        )}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-3.5 shrink-0" />
          <span>{fixLoopStatusLabel(fixLoop)}</span>
          {escalates && (
            <span className="text-muted-foreground ml-auto text-[11px]">
              Next round hands off to a fresh implementer
            </span>
          )}
        </div>
        {detail !== null && (
          <p className="pl-[1.375rem] text-[12px] whitespace-pre-wrap opacity-90">
            {detail}
          </p>
        )}
      </div>
    </MainSection>
  );
}
