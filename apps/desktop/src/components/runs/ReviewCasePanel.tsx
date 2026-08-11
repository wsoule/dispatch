import type { ApiClient, Finding } from '@dispatch/client';
import type {
  CommandEvidence,
  LedgerEntry,
  MutationEvidence,
} from '@dispatch/core/browser';
import {
  Bot,
  Check,
  ChevronRight,
  Flag,
  TriangleAlert,
  Waypoints,
  Wrench,
  X,
} from 'lucide-react';
import { useState } from 'react';

import type { ImpactSubjectRef } from '../../lib/appNav';
import type { CheckGroup } from '../../lib/findings';
import { partitionFindings } from '../../lib/findings';
import { isDeadGuard } from '../../lib/reviewCase';
import { ImpactPanel } from '../impact/ImpactPanel';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import { ScrollArea } from '@/ui/scroll-area';

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
  /** True while a review agent's run is live over this run's branch — derived from the run
   * list rather than click-local state, so it survives navigation (see `liveReviewAgentFor`). */
  reviewAgentLive?: boolean;
  /** Hands the checked findings to an agent to fix — the run resumes on its own branch with
   * them attached (the request-changes path). Omitted where fixing isn't possible (the run is
   * already reviewed, or still live): the checkboxes and button hide rather than disable. */
  onFixFindings?: (findings: Finding[]) => Promise<void>;
  /** The dispatchd client and this run's id — both required to embed the
   *  blast-radius panel. Omitted (as in this component's own tests) hides
   *  the Impact section entirely rather than rendering it half-wired. */
  client?: ApiClient | null;
  runId?: string;
  /** Navigates to the full `ImpactView`, this run preselected. Optional so
   *  older/test call sites keep compiling with the button hidden. */
  onOpenImpact?: (subject: ImpactSubjectRef) => void;
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
  reviewAgentLive = false,
  onFixFindings,
  client,
  runId,
  onOpenImpact,
}: ReviewCasePanelProps) {
  const { judgment, checks } = partitionFindings(findings);

  // Which judgment findings are checked for the fix action. Ephemeral on
  // purpose: a selection is a half-formed intention, unlike the dispatched
  // fix itself, which the run list remembers.
  const [selectedFindingIds, setSelectedFindingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [fixBusy, setFixBusy] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  function toggleFinding(id: string) {
    setSelectedFindingIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function fixSelected() {
    if (onFixFindings === undefined) return;
    const picked = judgment
      .flatMap((group) => group.findings)
      .filter((f) => selectedFindingIds.has(f.id));
    if (picked.length === 0) return;
    setFixBusy(true);
    setFixError(null);
    try {
      await onFixFindings(picked);
      setSelectedFindingIds(new Set());
    } catch (err) {
      setFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixBusy(false);
    }
  }
  const openCount = judgment.reduce((n, g) => n + g.findings.length, 0);

  // `h-full min-h-0`: this panel is the sole flexible child of ReviewView's own
  // `flex-1 flex-col` pane, so it has to actually claim that space itself before
  // ScrollArea's Viewport (which only ever fills its own Root, `size-full`) has
  // anything real to scroll within.
  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-5 p-1">
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

        {/* Only ever mounted when a real run is behind this panel — the caller
          (ReviewView) always has both; this component's own tests exercise
          `empty` without them, which just hides the section. */}
        {client !== undefined && runId !== undefined && (
          <section>
            <SectionLabel rule>Impact</SectionLabel>
            <div className="mt-2 flex flex-col items-start gap-2">
              <ImpactPanel client={client} subject="run" id={runId} />
              {onOpenImpact && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onOpenImpact({ kind: 'run', id: runId })}
                >
                  <Waypoints className="size-3.5" />
                  Open in Impact
                </Button>
              )}
            </div>
          </section>
        )}

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
                      ? '0 tests failed: dead guard or vacuous test'
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
          {judgment.length === 0 ? (
            <div className="mt-2 flex flex-col items-start gap-2">
              {/* Never "no findings": an empty set means nobody looked, and saying otherwise
                would turn an absent review into a clean bill of health. */}
              <p className="text-muted-foreground text-[12.5px]">
                {reviewAgentLive
                  ? 'An agent is reviewing this diff — its findings land here once it finishes.'
                  : 'No agent review has run over this diff.'}
              </p>
              {onStartAiReview !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiReviewBusy || reviewAgentLive}
                  onClick={() => void onStartAiReview()}
                >
                  <Bot className="size-3.5" />
                  {reviewAgentLive
                    ? 'Agent reviewing…'
                    : aiReviewBusy
                      ? 'Starting…'
                      : 'Ask an agent to review'}
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-3">
              {judgment.map((group) => (
                <div key={group.severity} className="flex flex-col gap-2">
                  <SectionLabel count={group.findings.length}>
                    {group.severity}
                  </SectionLabel>
                  {group.findings.map((f) => (
                    <FindingRow
                      key={f.id}
                      finding={f}
                      selected={selectedFindingIds.has(f.id)}
                      onToggleSelect={
                        onFixFindings === undefined
                          ? undefined
                          : () => toggleFinding(f.id)
                      }
                    />
                  ))}
                </div>
              ))}
              {onFixFindings !== undefined && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={fixBusy || selectedFindingIds.size === 0}
                    onClick={() => void fixSelected()}
                  >
                    <Wrench className="size-3.5" />
                    {fixBusy
                      ? 'Sending to the agent…'
                      : selectedFindingIds.size > 0
                        ? `Fix ${selectedFindingIds.size} selected`
                        : 'Fix selected'}
                  </Button>
                  {fixError !== null && (
                    <span className="text-state-failed text-[11px]">
                      {fixError}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {checks.length > 0 && (
          <section>
            {/* The count is rules, not rows: one rule can span a hundred files. */}
            <SectionLabel rule count={checks.length}>
              Checks that fired
            </SectionLabel>
            <div className="mt-2 flex flex-col gap-1">
              {checks.map((group) => (
                <CheckRow key={group.rule} group={group} />
              ))}
            </div>
          </section>
        )}

        {decisions.length > 0 && (
          <section>
            <SectionLabel rule count={decisions.length}>
              Decisions it escalated
            </SectionLabel>
            <DecisionList entries={decisions} />
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

// Past this, a detail is a wall rather than a sentence, and gets a toggle.
const DETAIL_CLAMP_CHARS = 220;

/** One agent-raised finding. The title wraps and the detail clamps — the
 *  inverse of the first cut, where a clipped title sat above an unbounded
 *  paragraph. `onToggleSelect` adds the fix-selection checkbox; absent, the
 *  row renders exactly as before. */
function FindingRow({
  finding,
  selected = false,
  onToggleSelect,
}: {
  finding: Finding;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = finding.detail.length > DETAIL_CLAMP_CHARS;
  return (
    <div className="text-[12.5px]">
      <div className="flex items-baseline gap-1.5">
        {onToggleSelect !== undefined && (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelect}
            aria-label={`Select finding: ${finding.title}`}
            className="self-center"
          />
        )}
        <TriangleAlert className="text-state-waiting size-3 shrink-0 self-center" />
        <span className="min-w-0 flex-1">{finding.title}</span>
        {finding.file !== null && (
          <span className="dense-meta shrink-0">
            {finding.file}
            {finding.line !== null && `:${finding.line}`}
          </span>
        )}
      </div>
      <p
        className={cn(
          'text-muted-foreground pl-4.5 text-[11px] leading-snug',
          long && !expanded && 'line-clamp-2'
        )}
      >
        {finding.detail}
      </p>
      {long && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setExpanded((v) => !v)}
          className="text-accent-foreground h-auto p-0 pl-4.5 text-[11px] font-normal hover:bg-transparent"
        >
          {expanded ? 'less' : 'more'}
        </Button>
      )}
    </div>
  );
}

// How many paths a rule lists before it stops, so a rule that fired across a
// monorepo cannot put hundreds of rows in the panel.
const CHECK_FILE_CAP = 20;

/** One mechanical rule, collapsed to a single row. The count is what a
 *  reviewer decides on; the paths are evidence, behind a disclosure. */
function CheckRow({ group }: { group: CheckGroup }) {
  const [expanded, setExpanded] = useState(false);
  const shown = group.files.slice(0, CHECK_FILE_CAP);
  const hidden = group.files.length - shown.length;
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="text-[12.5px]"
    >
      {/* `group` + `group-data-[state=open]:rotate-90` rather than `expanded &&
          'rotate-90'` — the chevron reacts to the trigger's own Radix data-state
          instead of threading local state down another level. */}
      <CollapsibleTrigger className="group flex w-full items-baseline gap-1.5 text-left">
        <ChevronRight className="size-3 shrink-0 self-center transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1">{group.rule}</span>
        <span className="dense-meta shrink-0">
          {group.files.length} file{group.files.length === 1 ? '' : 's'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="text-muted-foreground mt-1 flex flex-col gap-0.5 pl-4.5 text-[11px]">
          {shown.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
          {hidden > 0 && <li className="dense-meta">+{hidden} more</li>}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Ledger hazards fan out per file the same way findings did; same cap.
const DECISION_CAP = 8;

/** The escalated decisions, capped so the section opens short and offers the
 *  rest rather than running past the fold. */
function DecisionList({ entries }: { entries: LedgerEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? entries : entries.slice(0, DECISION_CAP);
  return (
    <div className="mt-2 flex flex-col gap-2">
      {shown.map((d) => (
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
      {entries.length > DECISION_CAP && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setShowAll((v) => !v)}
          className="text-accent-foreground h-auto self-start p-0 pl-4.5 text-[11px] font-normal hover:bg-transparent"
        >
          {showAll ? 'Show fewer' : `Show all ${entries.length}`}
        </Button>
      )}
    </div>
  );
}
