import type { EscalationStep } from '@dispatch-foo/core/browser';
import type { FixLoopState } from '@dispatch/client';
import { Button, cx, SectionHeader, TaskDetailSection } from '@dispatch/ui';
import { Loader2, ShieldAlert, Square, Wrench } from 'lucide-react';

import {
  fixLoopStatusLabel,
  fixLoopStopDetail,
  fixLoopTone,
  fixLoopTraceLabel,
  fixLoopUiTone,
  willEscalateNextRound,
} from '../../../lib/fixLoopStatus';
import styles from './sections.module.css';

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

// The fix loop as a library SectionHeader bar (glyph, status line, small
// buttons at the right; a loop waiting on a ruling or one that failed adds the
// tone's diamond and left edge, the status line saying the same in words), with
// the trace, stop detail, hints and errors as quiet 12px lines beneath it.
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
  const uiTone = fixLoopUiTone(tone);
  return (
    <TaskDetailSection title="Fix loop" headingLevel={3}>
      <div className={styles.fixLoop}>
        <SectionHeader
          as="div"
          tone={uiTone}
          icon={
            <ShieldAlert
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
              className={styles.barIcon}
            />
          }
          name={
            fixLoop === null
              ? 'Not started — review and fixes run when you ask for them.'
              : fixLoopStatusLabel(fixLoop)
          }
          actions={
            action !== null || stoppable ? (
              <>
                {action !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={starting}
                    onClick={onStart}
                    icon={
                      starting ? (
                        <Loader2
                          size={14}
                          strokeWidth={1.8}
                          aria-hidden="true"
                          className={styles.spin}
                        />
                      ) : (
                        <Wrench
                          size={14}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      )
                    }
                  >
                    {action.label}
                  </Button>
                )}
                {stoppable && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={onStop}
                    icon={
                      <Square size={14} strokeWidth={1.8} aria-hidden="true" />
                    }
                  >
                    Stop
                  </Button>
                )}
              </>
            ) : undefined
          }
        />
        {hasLines && (
          <div className={styles.lines}>
            {escalates && (
              <p className={styles.note}>
                Next round hands off to a fresh implementer.
              </p>
            )}
            {trace !== null && (
              <p className={styles.note}>Findings per pass: {trace}</p>
            )}
            {detail !== null && (
              <p className={cx(styles.note, styles.detail)}>{detail}</p>
            )}
            {action !== null && <p className={styles.note}>{action.hint}</p>}
            {stoppable && (
              <p className={styles.note}>
                Stop caps the loop here; Review &amp; fix resumes it later.
              </p>
            )}
            {startError !== null && (
              <p className={cx('toneText', styles.note)} data-tone="danger">
                {startError}
              </p>
            )}
          </div>
        )}
      </div>
    </TaskDetailSection>
  );
}
