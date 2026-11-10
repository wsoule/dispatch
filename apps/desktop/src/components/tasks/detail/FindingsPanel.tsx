import type { AdjudicateFindingInput, Finding } from '@dispatch/client';
import { Button, Chip, cx, TaskDetailSection } from '@dispatch/ui';
import { useState } from 'react';

import {
  countOpenFindings,
  findingTone,
  groupOpenFindingsBySeverity,
  severityLabel,
} from '../../../lib/findings';
import styles from './sections.module.css';

// Two explicit actions, never a bare "submit": both disabled until a reason is
// actually typed, so the ruling requirement can't be missed. A native textarea
// over a row of small buttons, `Block` in the danger tone's text rather than a
// filled destructive button.
function AdjudicateFindingForm({
  onSubmit,
}: {
  onSubmit: (input: AdjudicateFindingInput) => Promise<void>;
}) {
  const [ruling, setRuling] = useState('');
  const [pending, setPending] = useState<'parked' | 'blocked' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const empty = ruling.trim() === '';

  async function submit(verdict: 'parked' | 'blocked') {
    setPending(verdict);
    setError(null);
    try {
      await onSubmit({ verdict, ruling: ruling.trim() });
      setRuling('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div data-slot="adjudicate-form" className={styles.form}>
      <textarea
        className={cx('textarea', styles.ruling)}
        rows={2}
        aria-label="Ruling"
        value={ruling}
        onChange={(e) => setRuling(e.target.value)}
        placeholder="Ruling (required to park or block)"
      />
      {error !== null && (
        <p className={cx('toneText', styles.note)} data-tone="danger">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          disabled={empty || pending !== null}
          busy={pending === 'parked'}
          busyLabel="Parking…"
          onClick={() => void submit('parked')}
        >
          Park
        </Button>
        <Button
          size="sm"
          variant="quiet"
          disabled={empty || pending !== null}
          busy={pending === 'blocked'}
          busyLabel="Blocking…"
          onClick={() => void submit('blocked')}
        >
          <span className="toneText" data-tone="danger">
            Block
          </span>
        </Button>
      </div>
    </div>
  );
}

// The heading's meta names the severity mix so it's visible without scrolling
// the grouped body below, e.g. "3 open (1 critical, 2 minor)".
function findingsSummary(findings: Finding[]): string {
  const counts = countOpenFindings(findings);
  const bySeverity = [
    counts.critical > 0 ? `${counts.critical} critical` : null,
    counts.important > 0 ? `${counts.important} important` : null,
    counts.minor > 0 ? `${counts.minor} minor` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(', ');
  return bySeverity === ''
    ? `${counts.open} open`
    : `${counts.open} open (${bySeverity})`;
}

// The open findings grouped most severe first, each group under a severity
// chip toned by `findingTone` (its words always say the severity), each finding
// a comment card with its file location in mono. The adjudication form only
// attaches while the fix loop is capped: that is the one moment a ruling
// actually does anything.
export function FindingsPanel({
  findings,
  needsRuling,
  onAdjudicate,
}: {
  findings: Finding[];
  needsRuling: boolean;
  onAdjudicate: (
    findingId: string,
    input: AdjudicateFindingInput
  ) => Promise<void>;
}) {
  const groups = groupOpenFindingsBySeverity(findings);
  if (groups.length === 0) return null;
  return (
    <TaskDetailSection
      title="Findings"
      headingLevel={3}
      meta={
        <span data-slot="findings-summary" className="num">
          {findingsSummary(findings)}
        </span>
      }
    >
      <div className={styles.body}>
        {groups.map((group) => (
          <div
            key={group.severity}
            data-slot="findings-group"
            className={styles.group}
          >
            <div className={styles.groupHead}>
              <Chip data-slot="label-pill" tone={findingTone(group.severity)}>
                {severityLabel(group.severity)}
              </Chip>
              <span className={styles.count}>{group.findings.length}</span>
            </div>
            <ul className={styles.list}>
              {group.findings.map((finding) => (
                <li
                  key={finding.id}
                  data-slot="finding-card"
                  className={styles.card}
                >
                  <div className={styles.cardTitle}>{finding.title}</div>
                  {finding.file !== null && (
                    <span className={cx('mono', styles.cardLine)}>
                      {finding.file}
                      {finding.line !== null ? `:${finding.line}` : ''}
                    </span>
                  )}
                  <p className={styles.cardBody}>{finding.detail}</p>
                  {needsRuling && (
                    <AdjudicateFindingForm
                      onSubmit={(input) => onAdjudicate(finding.id, input)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </TaskDetailSection>
  );
}
