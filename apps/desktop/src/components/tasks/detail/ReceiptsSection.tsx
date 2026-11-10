import type { LedgerEntry } from '@dispatch-foo/core/browser';
import { cx, TaskDetailSection } from '@dispatch/ui';

import { PolicyReceiptBadge } from '../../ledger/PolicyReceiptBadge';
import styles from './sections.module.css';

const LEDGER_KIND_ORDER: readonly LedgerEntry['kind'][] = [
  'constraint',
  'hazard',
  'decision',
  'handoff',
];

// Plural, sentence case: each is a 12px / 500 sub-heading over a run of cards.
const LEDGER_KIND_LABEL: Record<LedgerEntry['kind'], string> = {
  constraint: 'Constraints',
  hazard: 'Hazards',
  decision: 'Decisions',
  handoff: 'Handoffs',
};

// The ledger's audit receipts — a milestone's, or a plain task's own: policy
// decisions, scope grants, undeclared writes. Grouped by kind and attributed
// to the task that raised each one (its id in mono, a machine-read string);
// its lessons live in memory instead.
export function ReceiptsSection({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return null;
  const groups = LEDGER_KIND_ORDER.map((kind) => ({
    kind,
    entries: entries.filter((e) => e.kind === kind),
  })).filter((group) => group.entries.length > 0);
  return (
    <TaskDetailSection title="Receipts" headingLevel={3} count={entries.length}>
      <div className={styles.body}>
        {groups.map((group) => (
          <div
            key={group.kind}
            data-slot="receipt-group"
            className={styles.group}
          >
            <span className={styles.groupHead}>
              {LEDGER_KIND_LABEL[group.kind]}
              <span className={styles.count}>{group.entries.length}</span>
            </span>
            <ul className={styles.list}>
              {group.entries.map((entry) => (
                <li
                  key={entry.id}
                  data-slot="receipt-entry"
                  className={styles.card}
                >
                  <div className={styles.cardHead}>
                    <span className={styles.cardTitle}>{entry.title}</span>
                    <PolicyReceiptBadge entry={entry} />
                    {entry.sourceTaskId !== null && (
                      <span
                        data-slot="receipt-source"
                        className={cx('mono', styles.source)}
                      >
                        {entry.sourceTaskId}
                      </span>
                    )}
                  </div>
                  <p className={styles.cardBody}>{entry.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </TaskDetailSection>
  );
}
