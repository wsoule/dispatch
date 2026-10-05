import type { LedgerEntry } from '@dispatch-foo/core/browser';

import { PolicyReceiptBadge } from '../../ledger/PolicyReceiptBadge';
import { MainSection } from './MainSection';

const LEDGER_KIND_ORDER: readonly LedgerEntry['kind'][] = [
  'constraint',
  'hazard',
  'decision',
  'handoff',
];

// Plural, sentence case: each is a sub-heading over a run of cards.
const LEDGER_KIND_LABEL: Record<LedgerEntry['kind'], string> = {
  constraint: 'Constraints',
  hazard: 'Hazards',
  decision: 'Decisions',
  handoff: 'Handoffs',
};

// The ledger's audit receipts — an epic's, or a plain task's own: policy
// decisions, scope grants, undeclared writes. Grouped by kind and attributed
// to the task that raised each one; its lessons live in memory instead.
export function ReceiptsSection({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return null;
  const groups = LEDGER_KIND_ORDER.map((kind) => ({
    kind,
    entries: entries.filter((e) => e.kind === kind),
  })).filter((group) => group.entries.length > 0);
  return (
    <MainSection
      title="Receipts"
      trailing={
        <span className="text-muted-foreground font-book text-[12px] tabular-nums">
          {entries.length}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div
            key={group.kind}
            data-slot="receipt-group"
            className="flex flex-col gap-1.5"
          >
            <span className="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium">
              {LEDGER_KIND_LABEL[group.kind]}
              <span className="font-book tabular-nums">
                {group.entries.length}
              </span>
            </span>
            <ul className="flex flex-col gap-2">
              {group.entries.map((entry) => (
                <li
                  key={entry.id}
                  data-slot="receipt-entry"
                  className="bg-surface-quaternary rounded-card border-border-strong border-[0.5px] p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-foreground min-w-0 text-[13px] font-medium break-words">
                      {entry.title}
                    </span>
                    <PolicyReceiptBadge entry={entry} />
                    {entry.sourceTaskId !== null && (
                      <span
                        data-slot="receipt-source"
                        className="text-muted-foreground font-book ml-auto shrink-0 text-[12px] tracking-(--id-tracking)"
                      >
                        {entry.sourceTaskId}
                      </span>
                    )}
                  </div>
                  {/* Scope grants put absolute paths in here, which have no
                      break opportunity of their own. */}
                  <p className="text-muted-foreground font-book mt-1 text-[13px] break-words whitespace-pre-wrap">
                    {entry.detail}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </MainSection>
  );
}
