import type { Finding } from '@dispatch/client';
import type {
  CommandEvidence,
  LedgerEntry,
  MutationEvidence,
} from '@dispatch/core/browser';
import { Bot, Check, Flag, TriangleAlert, X } from 'lucide-react';

import { groupOpenFindingsBySeverity } from '../../lib/findings';
import { isDeadGuard } from '../../lib/reviewCase';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

interface ReviewCasePanelProps {
  evidence: CommandEvidence[];
  mutations: MutationEvidence[];
  /** Open findings from the agent review. Empty means no review has run — which this says
   * outright, since reading it as "clean" is the one way this panel could mislead. */
  findings: Finding[];
  /** Decisions and hazards this run's task filed to the ledger. */
  decisions: LedgerEntry[];
  onStartAiReview?: () => Promise<void>;
  aiReviewBusy?: boolean;
}

/**
 * The agent's own account of the work, which the review opens on.
 *
 * Everything here was recorded by the agent *for a reviewer to read* — `record_evidence`,
 * `record_mutation` and `record_decision` in packages/mcp/src/tools.ts — and none of it was
 * rendered anywhere in the app before this panel. Reviewing an agent's work starts with what it
 * claims it checked, not with file 1 of 10.
 */
export function ReviewCasePanel({
  evidence,
  mutations,
  findings,
  decisions,
  onStartAiReview,
  aiReviewBusy = false,
}: ReviewCasePanelProps) {
  const findingGroups = groupOpenFindingsBySeverity(findings);
  const openCount = findingGroups.reduce((n, g) => n + g.findings.length, 0);

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-1">
      <section>
        <SectionLabel rule count={evidence.length}>
          What the agent verified
        </SectionLabel>
        {evidence.length === 0 ? (
          // The absence is the finding, so this must not read as a blank section or a tick.
          <p className="text-state-waiting mt-2 text-[12.5px]">
            The agent recorded no verification.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1">
            {evidence.map((e) => (
              <div
                key={`${e.at}-${e.command}`}
                className="flex items-baseline gap-2 text-[12.5px]"
              >
                {e.exitCode === 0 ? (
                  <Check className="text-state-review size-3 shrink-0" />
                ) : (
                  <X className="text-state-failed size-3 shrink-0" />
                )}
                <code className="min-w-0 flex-1 truncate">{e.command}</code>
                <span className="dense-meta shrink-0">{e.summary}</span>
                <span className="dense-meta shrink-0">
                  {(e.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {mutations.length > 0 && (
        <section>
          <SectionLabel rule count={mutations.length}>
            Guards it mutation-tested
          </SectionLabel>
          <div className="mt-2 flex flex-col gap-1">
            {mutations.map((m) => (
              <div
                key={`${m.at}-${m.guard}`}
                className="flex items-baseline gap-2 text-[12.5px]"
              >
                {isDeadGuard(m) ? (
                  <TriangleAlert className="text-state-waiting size-3 shrink-0" />
                ) : (
                  <Check className="text-state-review size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{m.guard}</span>
                <span className="dense-meta shrink-0">{m.file}</span>
                <span
                  className={
                    isDeadGuard(m)
                      ? 'text-state-waiting shrink-0 text-[11px]'
                      : 'dense-meta shrink-0'
                  }
                >
                  {isDeadGuard(m)
                    ? '0 tests failed — dead guard, or a vacuous test'
                    : `${m.testsFailed} tests failed`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionLabel rule count={openCount}>
          Agent review
        </SectionLabel>
        {findingGroups.length === 0 ? (
          <div className="mt-2 flex flex-col items-start gap-2">
            {/* Never "no findings": an empty set means nobody looked, and saying otherwise
                would turn an absent review into a clean bill of health. */}
            <p className="text-muted-foreground text-[12.5px]">
              No agent review has run over this diff.
            </p>
            {onStartAiReview !== undefined && (
              <Button
                variant="outline"
                size="sm"
                disabled={aiReviewBusy}
                onClick={() => void onStartAiReview()}
              >
                <Bot className="size-3.5" />
                {aiReviewBusy ? 'Starting…' : 'Ask an agent to review'}
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {findingGroups.map((group) =>
              group.findings.map((f) => (
                <div key={f.id} className="text-[12.5px]">
                  <div className="flex items-center gap-1.5">
                    <TriangleAlert className="text-state-waiting size-3 shrink-0" />
                    <span className="dense-meta shrink-0">{f.severity}</span>
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                    {f.file !== null && (
                      <span className="dense-meta shrink-0">
                        {f.file}
                        {f.line !== null && `:${f.line}`}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground pl-4.5 text-[11px] leading-snug">
                    {f.detail}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {decisions.length > 0 && (
        <section>
          <SectionLabel rule count={decisions.length}>
            Decisions it escalated
          </SectionLabel>
          <div className="mt-2 flex flex-col gap-2">
            {decisions.map((d) => (
              <div key={d.id} className="text-[12.5px]">
                <div className="flex items-center gap-1.5">
                  <Flag
                    className={
                      d.kind === 'hazard'
                        ? 'text-state-waiting size-3 shrink-0'
                        : 'text-muted-foreground size-3 shrink-0'
                    }
                  />
                  <span className="dense-meta shrink-0">{d.kind}</span>
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                </div>
                <p className="text-muted-foreground pl-4.5 text-[11px] leading-snug">
                  {d.detail}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
