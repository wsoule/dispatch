import type {
  CommandEvidence,
  LedgerEntry,
  MutationEvidence,
} from '@dispatch-foo/core/browser';
import type { ApiClient, Finding } from '@dispatch/client';
import {
  Button,
  Checkbox,
  ChipButton,
  cx,
  Disclosure,
  SectionHeader,
  type UiTone,
} from '@dispatch/ui';
import {
  Bot,
  Check,
  ChevronRight,
  Flag,
  type LucideIcon,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import { useState } from 'react';

import type { CheckGroup } from '../../lib/findings';
import { partitionFindings } from '../../lib/findings';
import { isDeadGuard } from '../../lib/reviewCase';
import { ImpactPanel } from '../impact/ImpactPanel';
import { PolicyReceiptBadge } from '../ledger/PolicyReceiptBadge';
import styles from './ReviewCasePanel.module.css';

// The 12px glyph a row leads with, and the one inside a chip button.
const GLYPH = { size: 12, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** A row's status glyph in its tone's ink (the global .toneText), with the
 *  word it stands for beside it for assistive tech: colour and shape are
 *  never the only cue. Failed is danger, passed success, pending muted and
 *  blocked or at risk warning, as the status table has it. */
function ToneGlyph({
  icon: Icon,
  tone,
  word,
}: {
  icon: LucideIcon;
  tone: UiTone;
  word: string;
}) {
  return (
    <span className={cx(styles.glyph, 'toneText')} data-tone={tone}>
      <Icon {...GLYPH} />
      <span className="srOnly">{word}</span>
    </span>
  );
}

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
}

/**
 * The agent's own account of the work, which the review opens on.
 *
 * Everything here was recorded by the agent *for a reviewer to read* — `record_evidence` and
 * `record_mutation` in packages/mcp/src/tools.ts, and its task's decisions — and none of it was
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

  // The panel scrolls itself: it is the sole flexible child of the review
  // page's own column, so it claims that height and overflows inside it.
  return (
    <div className={styles.root}>
      <div className={styles.stack}>
        <section className={styles.section}>
          <SectionHeader
            name="What the agent verified"
            count={evidence.length}
            rule
          />
          {evidence.length === 0 ? (
            // The absence is the finding, so this must not read as a blank
            // section or a tick: a missing input, in the warning tone's ink.
            <p className={cx(styles.lead, 'toneText')} data-tone="warning">
              The agent recorded no verification.
            </p>
          ) : (
            <div className={styles.rows}>
              {evidence.map((e) => (
                <div key={`${e.at}-${e.command}`} className={styles.row}>
                  {e.exitCode === 0 ? (
                    <ToneGlyph icon={Check} tone="success" word="Passed" />
                  ) : (
                    <ToneGlyph icon={X} tone="danger" word="Failed" />
                  )}
                  <code className={styles.command}>{e.command}</code>
                  <span className={styles.meta}>{e.summary}</span>
                  <span className={styles.meta}>
                    {(e.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Only ever mounted when a real run is behind this panel — the caller
          (the task view's Diff tab) always has both; this component's own tests exercise
          `empty` without them, which just hides the section. The library
          Panel inside heads it "Impact", so it takes no second header. */}
        {client !== undefined && runId !== undefined && (
          <section className={styles.section}>
            <ImpactPanel client={client} subject="run" id={runId} />
          </section>
        )}

        {mutations.length > 0 && (
          <section className={styles.section}>
            <SectionHeader
              name="Guards it mutation-tested"
              count={mutations.length}
              rule
            />
            <div className={styles.rows}>
              {mutations.map((m) => {
                const dead = isDeadGuard(m);
                return (
                  <div key={`${m.at}-${m.guard}`} className={styles.row}>
                    {dead ? (
                      <ToneGlyph
                        icon={TriangleAlert}
                        tone="warning"
                        word="Dead guard"
                      />
                    ) : (
                      <ToneGlyph icon={Check} tone="success" word="Guarded" />
                    )}
                    <span className={styles.name}>{m.guard}</span>
                    <span className={styles.path}>{m.file}</span>
                    {dead ? (
                      <span
                        className={cx(styles.meta, 'toneText')}
                        data-tone="warning"
                      >
                        0 tests failed: dead guard or vacuous test
                      </span>
                    ) : (
                      <span className={styles.meta}>
                        {`${m.testsFailed} tests failed`}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className={styles.section}>
          <SectionHeader name="Agent review" count={openCount} rule />
          {judgment.length === 0 ? (
            <div className={styles.empty}>
              {/* Never "no findings": an empty set means nobody looked, and saying otherwise
                would turn an absent review into a clean bill of health. */}
              <p className={styles.lead}>
                {reviewAgentLive
                  ? 'An agent is reviewing this diff — its findings land here once it finishes.'
                  : 'No agent review has run over this diff.'}
              </p>
              {onStartAiReview !== undefined && (
                <ChipButton
                  disabled={aiReviewBusy || reviewAgentLive}
                  onClick={() => void onStartAiReview()}
                >
                  <span className={styles.chipBody}>
                    <Bot {...GLYPH} />
                    {reviewAgentLive
                      ? 'Agent reviewing…'
                      : aiReviewBusy
                        ? 'Starting…'
                        : 'Ask an agent to review'}
                  </span>
                </ChipButton>
              )}
            </div>
          ) : (
            <div className={styles.groups}>
              {judgment.map((group) => (
                <div key={group.severity} className={styles.group}>
                  <SectionHeader
                    as="h4"
                    name={group.severity}
                    count={group.findings.length}
                  />
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
                <div className={styles.fix}>
                  <ChipButton
                    disabled={fixBusy || selectedFindingIds.size === 0}
                    onClick={() => void fixSelected()}
                  >
                    <span className={styles.chipBody}>
                      <Wrench {...GLYPH} />
                      {fixBusy
                        ? 'Sending to the agent…'
                        : selectedFindingIds.size > 0
                          ? `Fix ${selectedFindingIds.size} selected`
                          : 'Fix selected'}
                    </span>
                  </ChipButton>
                  {fixError !== null && (
                    <span
                      className={cx(styles.meta, 'toneText')}
                      data-tone="danger"
                      role="alert"
                    >
                      {fixError}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {checks.length > 0 && (
          <section className={styles.section}>
            {/* The count is rules, not rows: one rule can span a hundred files. */}
            <SectionHeader
              name="Checks that fired"
              count={checks.length}
              rule
            />
            <div className={styles.rows}>
              {checks.map((group) => (
                <CheckRow key={group.rule} group={group} />
              ))}
            </div>
          </section>
        )}

        {decisions.length > 0 && (
          <section className={styles.section}>
            <SectionHeader
              name="Decisions it escalated"
              count={decisions.length}
              rule
            />
            <DecisionList entries={decisions} />
          </section>
        )}
      </div>
    </div>
  );
}

// Past this, a detail is a wall rather than a sentence, and gets a toggle.
const DETAIL_CLAMP_CHARS = 220;

/** One agent-raised finding. The title wraps and the detail clamps — the
 *  inverse of the first cut, where a clipped title sat above an unbounded
 *  paragraph. `onToggleSelect` adds the fix-selection checkbox (the library
 *  Checkbox, its label kept for assistive tech); absent, the row renders
 *  exactly as before. */
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
    <div className={styles.finding}>
      <div className={styles.row}>
        {onToggleSelect !== undefined && (
          <span className={styles.select}>
            <Checkbox
              checked={selected}
              onChange={() => onToggleSelect()}
              label={`Select finding: ${finding.title}`}
              hideLabel
            />
          </span>
        )}
        <ToneGlyph icon={TriangleAlert} tone="warning" word="Open finding" />
        <span className={styles.findingTitle}>{finding.title}</span>
        {finding.file !== null && (
          <span className={styles.path}>
            {finding.file}
            {finding.line !== null && `:${finding.line}`}
          </span>
        )}
      </div>
      <p className={cx(styles.detail, long && !expanded && styles.clamped)}>
        {finding.detail}
      </p>
      {long && (
        <span className={styles.indent}>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Less' : 'More'}
          </Button>
        </span>
      )}
    </div>
  );
}

// How many paths a rule lists before it stops, so a rule that fired across a
// monorepo cannot put hundreds of rows in the panel.
const CHECK_FILE_CAP = 20;

/** One mechanical rule, collapsed to a single row: the library Disclosure
 *  with a full-width trigger (chevron, rule, file count). The count is what
 *  a reviewer decides on; the paths are evidence, mounted only while open. */
function CheckRow({ group }: { group: CheckGroup }) {
  const shown = group.files.slice(0, CHECK_FILE_CAP);
  const hidden = group.files.length - shown.length;
  return (
    <Disclosure
      variant="plain"
      trigger={({ props }) => (
        <button {...props} className={styles.checkTrigger}>
          <ChevronRight className={styles.chevron} {...GLYPH} />
          <span className={styles.name}>{group.rule}</span>
          <span className={styles.meta}>
            {group.files.length} file{group.files.length === 1 ? '' : 's'}
          </span>
        </button>
      )}
    >
      <ul className={styles.paths}>
        {shown.map((path) => (
          <li key={path} className={styles.pathItem}>
            {path}
          </li>
        ))}
        {hidden > 0 && <li className={styles.meta}>+{hidden} more</li>}
      </ul>
    </Disclosure>
  );
}

// Ledger hazards fan out per file the same way findings did; same cap.
const DECISION_CAP = 8;

/** The escalated decisions, capped so the section opens short and offers the
 *  rest rather than running past the fold. A hazard's flag takes the warning
 *  tone, a decision's stays muted; the kind word beside it says which. */
function DecisionList({ entries }: { entries: LedgerEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? entries : entries.slice(0, DECISION_CAP);
  return (
    <div className={styles.decisions}>
      {shown.map((d) => (
        <div key={d.id} className={styles.decision}>
          <div className={styles.decisionHead}>
            <span
              className={cx(styles.glyph, 'toneText')}
              data-tone={d.kind === 'hazard' ? 'warning' : 'muted'}
            >
              <Flag {...GLYPH} />
            </span>
            <span className={styles.meta}>{d.kind}</span>
            <span className={styles.decisionTitle}>{d.title}</span>
            <PolicyReceiptBadge entry={d} />
          </div>
          <p className={styles.detail}>{d.detail}</p>
        </div>
      ))}
      {entries.length > DECISION_CAP && (
        <span className={styles.indent}>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : `Show all ${entries.length}`}
          </Button>
        </span>
      )}
    </div>
  );
}
