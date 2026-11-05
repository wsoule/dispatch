import { Button, Notice } from '@dispatch/ui';

import styles from './EnrichReview.module.css';

/** The sections an "Add detail" pass proposes — structurally `EnrichDraft`, but
 * inline here so this component depends on neither caller's module. */
interface EnrichReviewDraft {
  description: string;
  acceptanceCriteria: string[];
}

/**
 * A drafted "Add detail" proposal, shown read-only for a yes/no before anything
 * is written: a neutral library Notice led by "Suggested", 12px sentence-case
 * sub-headings over the drafted prose, then Apply (primary) and Discard (quiet).
 * Used by the task detail dialog — the brain dump row's own "Add detail" is a plain
 * inline edit now, with nothing to review.
 */
export function EnrichReview({
  draft,
  applying,
  onApply,
  onDiscard,
  applyLabel = 'Apply to task',
  discardLabel = 'Discard',
  note = 'Applying replaces the description and acceptance criteria below.',
}: {
  draft: EnrichReviewDraft;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
  applyLabel?: string;
  discardLabel?: string;
  note?: string;
}) {
  return (
    <Notice data-slot="enrich-review" tone="default" label="Suggested">
      <div className={styles.body}>
        <p className={styles.note}>{note}</p>

        {draft.description !== '' && (
          <div className={styles.part}>
            <h4 className={styles.heading}>Description</h4>
            <p className={styles.prose}>{draft.description}</p>
          </div>
        )}

        {draft.acceptanceCriteria.length > 0 && (
          <div className={styles.part}>
            <h4 className={styles.heading}>Acceptance criteria</h4>
            <ul className={styles.criteria}>
              {draft.acceptanceCriteria.map((criterion, i) => (
                <li key={`${i}-${criterion}`}>{criterion}</li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.actions}>
          <Button
            variant="primary"
            size="sm"
            busy={applying}
            busyLabel="Applying…"
            onClick={onApply}
          >
            {applyLabel}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={applying}
            onClick={onDiscard}
          >
            {discardLabel}
          </Button>
        </div>
      </div>
    </Notice>
  );
}
