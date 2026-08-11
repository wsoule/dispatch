import type { LedgerEntry } from '@dispatch/core/browser';

import { MainSection } from './MainSection';

const LEDGER_KIND_ORDER: readonly LedgerEntry['kind'][] = [
  'constraint',
  'hazard',
  'decision',
  'handoff',
];

const LEDGER_KIND_LABEL: Record<LedgerEntry['kind'], string> = {
  constraint: 'Constraint',
  hazard: 'Hazard',
  decision: 'Decision',
  handoff: 'Handoff',
};

// Carried-forward findings/decisions — an epic's, or a plain task's own —
// grouped by kind and attributed to the task that raised each one.
export function LedgerSection({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return null;
  const groups = LEDGER_KIND_ORDER.map((kind) => ({
    kind,
    entries: entries.filter((e) => e.kind === kind),
  })).filter((group) => group.entries.length > 0);
  return (
    <MainSection title={`Ledger · ${entries.length}`}>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.kind} className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              {LEDGER_KIND_LABEL[group.kind]} · {group.entries.length}
            </span>
            <ul className="flex flex-col gap-2">
              {group.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="border-border/60 rounded-md border px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 text-[13px] font-medium break-words">
                      {entry.title}
                    </span>
                    {entry.sourceTaskId !== null && (
                      <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">
                        {entry.sourceTaskId}
                      </span>
                    )}
                  </div>
                  {/* Scope grants put absolute paths in here, which have no
                      break opportunity of their own. */}
                  <p className="text-muted-foreground mt-1 text-[12.5px] break-words whitespace-pre-wrap">
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
