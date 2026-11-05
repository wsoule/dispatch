import type { VerificationCheck, VerificationResult } from '@dispatch/client';
import { Chip, ChipButton, cx, TaskDetailSection } from '@dispatch/ui';
import { FlaskConical } from 'lucide-react';

import { revealInFinder } from '../../../lib/tauri';
import {
  isRevealableArtifact,
  summarizeVerification,
  verificationCheckDetail,
} from '../../../lib/verificationSummary';
import { StatusIcon } from '../StatusIcon';
import styles from './sections.module.css';

// A check's pass/fail as the 14px status glyph: the done disk for a pass, the
// cancelled disk in the danger red for a failure. The glyph is decorative;
// the visually hidden word carries the meaning for a screen reader.
function CheckGlyph({ pass }: { pass: boolean }) {
  return (
    <>
      <span aria-hidden="true" className={styles.glyph}>
        {pass ? (
          <StatusIcon status="landed" />
        ) : (
          <StatusIcon status="dropped" tone="danger" />
        )}
      </span>
      <span className="srOnly">{pass ? 'Passed' : 'Failed'}</span>
    </>
  );
}

// One check row: glyph, name, and for a failure the expected/actual pair
// beneath it, the actual value in the danger tone's words.
function CheckRow({ check }: { check: VerificationCheck }) {
  const detail = verificationCheckDetail(check);
  return (
    <li
      data-slot="verification-check"
      data-pass={check.pass || undefined}
      className={styles.check}
    >
      <CheckGlyph pass={check.pass} />
      <div className={styles.checkBody}>
        <span>{check.check}</span>
        {detail !== null && (
          <dl className={styles.pair}>
            <dt>Expected</dt>
            <dd className={styles.expected}>{detail.expected}</dd>
            <dt>Actual</dt>
            <dd className="toneText" data-tone="danger">
              {detail.actual}
            </dd>
          </dl>
        )}
      </div>
    </li>
  );
}

// Artifacts as chips; a path is set in mono because it is a machine-read
// string, and an absolute path is a chip button that reveals the file in Finder.
function ArtifactChip({ path }: { path: string }) {
  if (isRevealableArtifact(path)) {
    return (
      <ChipButton
        title={path}
        onClick={() => {
          revealInFinder(path).catch((err: unknown) => {
            console.error(`Failed to reveal ${path}:`, err);
          });
        }}
      >
        <span className="mono">{path}</span>
      </ChipButton>
    );
  }
  return (
    <Chip title={path}>
      <span className="mono">{path}</span>
    </Chip>
  );
}

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
    <TaskDetailSection title="Verification" headingLevel={3}>
      <div className={styles.body}>
        <div className={styles.status}>
          {/* Exercised is a success in words and its tone's ink; not exercised
              carries no hue, only the quiet text step. */}
          <span
            className={cx(styles.exercised, exercised ? 'toneText' : undefined)}
            data-tone={exercised ? 'success' : undefined}
          >
            <FlaskConical size={14} strokeWidth={1.8} aria-hidden="true" />
            {exercised ? 'Exercised' : 'Not exercised'}
          </span>
          {error === null ? (
            <span className={styles.summaryLine}>· {summary.label}</span>
          ) : (
            <span
              className={cx('toneText', styles.summaryLine)}
              data-tone="danger"
            >
              · couldn&rsquo;t load checks
            </span>
          )}
        </div>
        {error !== null && (
          <p
            data-slot="load-error"
            className={cx('toneText', styles.note)}
            data-tone="danger"
          >
            {error}
          </p>
        )}
        {result !== null && result.checks.length > 0 && (
          <ul className={styles.checks}>
            {result.checks.map((check, i) => (
              <CheckRow key={i} check={check} />
            ))}
          </ul>
        )}
        {result !== null && result.artifacts.length > 0 && (
          <div className={styles.artifacts}>
            {result.artifacts.map((path) => (
              <ArtifactChip key={path} path={path} />
            ))}
          </div>
        )}
      </div>
    </TaskDetailSection>
  );
}
