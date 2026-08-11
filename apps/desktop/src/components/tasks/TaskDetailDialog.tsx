import type {
  AdjudicateFindingInput,
  ApiClient,
  FixLoopState,
  LinearIssueLink,
  LinearSyncSummary,
  PlanRecord,
  RunMeta,
  VerificationResult,
} from '@dispatch/client';
import type {
  EscalationStep,
  Finding,
  LedgerEntry,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core/browser';
import { parseExternal } from '@dispatch/core/browser';
import { computeStack } from '@dispatch/core/graph';
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  Eye,
  FlaskConical,
  Layers,
  Link2,
  Plus,
  ShieldAlert,
  Sparkles,
  Tag,
  Target,
  Waypoints,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  useAdjudicateFinding,
  useEpicLedger,
  useFixLoop,
  useProjectLedger,
  useTaskFindings,
  useTaskVerification,
} from '../../hooks/useOrchestration';
import type { ImpactSubjectRef } from '../../lib/appNav';
import { isFakeExecutorDevToolEnabled } from '../../lib/devTools';
import {
  countOpenFindings,
  groupOpenFindingsBySeverity,
} from '../../lib/findings';
import type { FixLoopTone } from '../../lib/fixLoopStatus';
import {
  fixLoopNeedsRuling,
  fixLoopStatusLabel,
  fixLoopStopDetail,
  fixLoopTone,
  willEscalateNextRound,
} from '../../lib/fixLoopStatus';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { taskLedgerEntries } from '../../lib/ledgerScope';
import { pushToLinearError, resolveLinearLink } from '../../lib/linearSettings';
import { mergeLadderLabel, mergeLadderState } from '../../lib/mergeLadder';
import { modelLabel, MODELS, readDefaultModel } from '../../lib/models';
import { isTerminalRunState } from '../../lib/runState';
import { parseTaskSections } from '../../lib/taskDisplay';
import {
  enrichDraftFromPlan,
  enrichPatch,
  enrichPlanError,
} from '../../lib/taskEnrich';
import { revealInFinder } from '../../lib/tauri';
import {
  summarizeVerification,
  verificationCheckDetail,
} from '../../lib/verificationSummary';
import { ImpactPanel } from '../impact/ImpactPanel';
import { PlanQuestionsForm } from '../plans/PlanQuestionsForm';
import { MergeLadderDot } from '../runs/MergeLadderDot';
import { RunStatePill } from '../runs/RunStatePill';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { EnrichReview } from './EnrichReview';
import { EpicDagModal } from './EpicDagModal';
import {
  AssigneeControl,
  EpicControl,
  PriorityControl,
  StatusControl,
} from './PropertyControls';
import { StackRail } from './StackRail';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/ui/select';
import { Textarea } from '@/ui/textarea';

// A titled group of rows in the rail (Properties, Labels, Blocked by) — the
// small muted header that lets Linear stack several property groups down the
// sidebar without any dividers doing the separating.
function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-muted-foreground/70 px-2 pb-1 text-[11px] font-medium tracking-wide">
        {title}
      </div>
      {children}
    </div>
  );
}

// A titled block in the main column (Description, Acceptance Criteria,
// Sessions, Activity) — a quiet header plus its content, separated from
// neighbors by whitespace rather than the heavy top-borders the old
// single-column layout stacked on every section.
function MainSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

// An inline-editable body section (Description, Acceptance Criteria): renders
// as borderless prose until focused, auto-grows to its content, and commits on
// blur only when the text actually changed — so reading the task costs nothing
// and editing is one click into the text. `value` is the section's current
// persisted text; the local draft resets whenever it (or the task) changes.
function EditableBodySection({
  title,
  value,
  placeholder,
  onSave,
}: {
  title: string;
  value: string;
  placeholder: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <MainSection title={title}>
      <Textarea
        className="text-foreground/90 hover:bg-muted/30 focus-visible:bg-muted/40 -mx-2 min-h-[2.25rem] resize-none rounded-md border-transparent bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed shadow-none transition-colors duration-150 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
      />
    </MainSection>
  );
}

// The milestone editor in the rail: a pick-or-type field (native datalist) over the
// project's existing milestone names, so assigning a task to a milestone reuses a name with
// one keystroke or coins a new one — no per-project milestone setup, matching the free-form
// model. Commits on blur; clearing it unsets the milestone.
function MilestoneRow({
  value,
  milestones,
  onChange,
}: {
  value: string | null;
  milestones: string[];
  onChange: (milestone: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return (
    <div className="hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
      <Target className="text-muted-foreground size-3.5 shrink-0" />
      <Input
        list="dispatch-milestones"
        className="h-auto min-w-0 flex-1 border-transparent bg-transparent p-0 shadow-none outline-none focus-visible:ring-0"
        placeholder="No milestone"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== (value ?? '')) onChange(next === '' ? null : next);
        }}
      />
      <datalist id="dispatch-milestones">
        {milestones.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

// The self-review toggle in the rail: when on, the orchestrator's prompt builder (see
// server's prompt.ts) appends an instruction telling the dispatched agent to re-review its
// own diff against the acceptance criteria before finishing, rather than stopping the moment
// tests pass. A plain checkbox rather than a picker (there's no "value" to choose, just
// on/off), styled like the other rail rows so it reads as one of them rather than a bolted-on
// control.
function SelfReviewRow({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      htmlFor="task-self-review"
      className="hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]"
    >
      <Eye className="text-muted-foreground size-3.5 shrink-0" />
      <span className="flex-1">Self review</span>
      <Checkbox
        id="task-self-review"
        checked={value}
        onCheckedChange={(checked) => onChange(checked === true)}
        aria-label="Self review before finishing"
      />
    </label>
  );
}

// The labels editor in the rail: existing labels as removable chips plus an
// input that adds a label on Enter. Labels are freeform strings, so this is a
// plain add/remove rather than a pick-from-list — deduped and trimmed before it
// calls back with the whole new list (matching UpdatePatch.labels' shape).
function LabelEditor({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const label = draft.trim();
    if (label !== '' && !labels.includes(label)) onChange([...labels, label]);
    setDraft('');
  }
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5">
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <Badge
              key={label}
              variant="secondary"
              className="gap-1 pr-1 text-[11px]"
            >
              {label}
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove label ${label}`}
                className="text-muted-foreground hover:text-foreground size-auto p-0 hover:bg-transparent has-[>svg]:px-0"
                onClick={() => onChange(labels.filter((l) => l !== label))}
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        className="h-7 text-[12px]"
        placeholder="Add label…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
        onBlur={add}
      />
    </div>
  );
}

// The blocked-by editor in the rail: current blockers as removable chips (each
// showing the blocking task's id) plus a Select of the other tasks in the
// project to add one. Unlike labels this IS a pick-from-list — a blocker has to
// be a real task id — so the add control is a dropdown of candidates (self and
// already-listed blockers filtered out) rather than a free-text input.
function BlockedByEditor({
  blockedBy,
  candidates,
  onChange,
}: {
  blockedBy: string[];
  candidates: TaskDoc[];
  onChange: (next: string[]) => void;
}) {
  const addable = candidates.filter((t) => !blockedBy.includes(t.meta.id));
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5">
      {blockedBy.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {blockedBy.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 pr-1 text-[11px]"
            >
              <span className="font-mono">{id}</span>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove blocker ${id}`}
                className="text-muted-foreground hover:text-foreground size-auto p-0 hover:bg-transparent has-[>svg]:px-0"
                onClick={() => onChange(blockedBy.filter((b) => b !== id))}
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      {addable.length > 0 && (
        // `key` on the Select resets it to the placeholder after each add, so it
        // never shows a stale "selected" blocker and can add several in a row.
        <Select
          key={blockedBy.join(',')}
          value=""
          onValueChange={(id) => onChange([...blockedBy, id])}
        >
          <SelectTrigger
            size="sm"
            className="text-muted-foreground h-7 w-full justify-start gap-1.5 text-[12px] [&>svg]:hidden"
          >
            <Plus className="size-3.5" />
            <span>Add blocker</span>
          </SelectTrigger>
          <SelectContent>
            {addable.map((t) => (
              <SelectItem key={t.meta.id} value={t.meta.id}>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {t.meta.id}
                </span>
                <span className="truncate">{t.meta.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// Two explicit actions, never a bare "submit" — both disabled until a
// reason is actually typed, so the ruling requirement can't be missed.
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
    <div className="border-border mt-1.5 flex flex-col gap-1.5 rounded-md border border-dashed p-2">
      <Textarea
        value={ruling}
        onChange={(e) => setRuling(e.target.value)}
        placeholder="Ruling (required to park or block)"
        className="min-h-[44px] text-[12px]"
      />
      {error !== null && (
        <div className="text-destructive text-[11px]">{error}</div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={empty || pending !== null}
          onClick={() => void submit('parked')}
        >
          {pending === 'parked' ? 'Parking…' : 'Park'}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={empty || pending !== null}
          onClick={() => void submit('blocked')}
        >
          {pending === 'blocked' ? 'Blocking…' : 'Block'}
        </Button>
      </div>
    </div>
  );
}

const SEVERITY_TONE: Record<Finding['severity'], string> = {
  critical: 'text-state-failed',
  important: 'text-state-waiting',
  minor: 'text-muted-foreground',
};

// The adjudication form only attaches while the fix loop is capped — that
// is the one moment a ruling actually does anything.
function FindingsPanel({
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
  const counts = countOpenFindings(findings);
  if (groups.length === 0) return null;
  // The header names the severity mix so it's visible without scrolling the
  // grouped body below — e.g. "3 open (1 critical, 2 minor)".
  const bySeverity = [
    counts.critical > 0 ? `${counts.critical} critical` : null,
    counts.important > 0 ? `${counts.important} important` : null,
    counts.minor > 0 ? `${counts.minor} minor` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(', ');
  const title =
    bySeverity === ''
      ? `Findings · ${counts.open} open`
      : `Findings · ${counts.open} open (${bySeverity})`;
  return (
    <MainSection title={title}>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.severity} className="flex flex-col gap-1.5">
            <span
              className={cn(
                'text-[11px] font-medium tracking-wide uppercase',
                SEVERITY_TONE[group.severity]
              )}
            >
              {group.severity} · {group.findings.length}
            </span>
            <ul className="flex flex-col gap-2">
              {group.findings.map((finding) => (
                <li
                  key={finding.id}
                  className="border-border/60 rounded-md border px-2.5 py-2"
                >
                  <div className="text-[13px] font-medium">{finding.title}</div>
                  {finding.file !== null && (
                    <div className="text-muted-foreground font-mono text-[11px]">
                      {finding.file}
                      {finding.line !== null ? `:${finding.line}` : ''}
                    </div>
                  )}
                  <p className="text-muted-foreground mt-1 text-[12.5px] whitespace-pre-wrap">
                    {finding.detail}
                  </p>
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
    </MainSection>
  );
}

// Only a loop actually waiting on a ruling gets the "needs you" amber
// treatment; an errored one reads as a failure and the rest stay neutral.
const FIX_LOOP_TONE_CLASS: Record<FixLoopTone, string> = {
  waiting:
    'border-state-waiting-edge bg-state-waiting-surface text-state-waiting',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-border/60',
};

function FixLoopSection({
  fixLoop,
  escalation,
}: {
  fixLoop: FixLoopState;
  escalation: EscalationStep[];
}) {
  const escalates = willEscalateNextRound(fixLoop, escalation);
  const detail = fixLoopStopDetail(fixLoop);
  return (
    <MainSection title="Fix loop">
      <div
        className={cn(
          'flex flex-col gap-1 rounded-md border px-2.5 py-2 text-[13px]',
          FIX_LOOP_TONE_CLASS[fixLoopTone(fixLoop)]
        )}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-3.5 shrink-0" />
          <span>{fixLoopStatusLabel(fixLoop)}</span>
          {escalates && (
            <span className="text-muted-foreground ml-auto text-[11px]">
              Next round hands off to a fresh implementer
            </span>
          )}
        </div>
        {detail !== null && (
          <p className="pl-[1.375rem] text-[12px] whitespace-pre-wrap opacity-90">
            {detail}
          </p>
        )}
      </div>
    </MainSection>
  );
}

// `exercised` stays visually distinct from review status; self-hides when
// there is nothing to say (never exercised, no result, no error).
function VerificationSection({
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
    <MainSection title="Verification">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[13px]">
          <FlaskConical
            className={cn(
              'size-3.5',
              exercised ? 'text-state-review' : 'text-muted-foreground'
            )}
          />
          <span
            className={
              exercised
                ? 'text-state-review font-medium'
                : 'text-muted-foreground'
            }
          >
            {exercised ? 'Exercised' : 'Not exercised'}
          </span>
          {error === null ? (
            <span className="text-muted-foreground text-[12px]">
              · {summary.label}
            </span>
          ) : (
            <span className="text-destructive text-[12px]">
              · couldn&rsquo;t load checks
            </span>
          )}
        </div>
        {error !== null && (
          <div className="text-destructive text-[12px]">{error}</div>
        )}
        {result !== null && result.checks.length > 0 && (
          <ul className="flex flex-col gap-1">
            {result.checks.map((check, i) => {
              const detail = verificationCheckDetail(check);
              return (
                <li key={i} className="text-[12px]">
                  <span
                    className={
                      check.pass ? 'text-state-review' : 'text-state-failed'
                    }
                  >
                    {check.pass ? '✓' : '✗'}
                  </span>{' '}
                  <span className="text-foreground/90">{check.check}</span>
                  {detail !== null && (
                    <dl className="text-muted-foreground mt-0.5 ml-[1.1rem] grid grid-cols-[4rem_1fr] gap-x-2 text-[11.5px]">
                      <dt>Expected</dt>
                      <dd className="text-foreground/80 break-words">
                        {detail.expected}
                      </dd>
                      <dt>Actual</dt>
                      <dd className="text-state-failed break-words">
                        {detail.actual}
                      </dd>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {result !== null && result.artifacts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {result.artifacts.map((path) =>
              path.startsWith('/') ? (
                <Button
                  key={path}
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    revealInFinder(path).catch((err: unknown) => {
                      console.error(`Failed to reveal ${path}:`, err);
                    });
                  }}
                  title={path}
                  className="border-border/60 text-muted-foreground hover:text-foreground h-auto max-w-full min-w-0 justify-start rounded border px-1.5 py-0.5 text-left font-mono text-[11px] break-all whitespace-normal hover:bg-transparent"
                >
                  {path}
                </Button>
              ) : (
                <span
                  key={path}
                  title={path}
                  className="text-muted-foreground max-w-full min-w-0 rounded border border-transparent px-1.5 py-0.5 font-mono text-[11px] break-all"
                >
                  {path}
                </span>
              )
            )}
          </div>
        )}
      </div>
    </MainSection>
  );
}

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
function LedgerSection({ entries }: { entries: LedgerEntry[] }) {
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

interface TaskDetailDialogProps {
  doc: TaskDoc;
  statuses: string[];
  ready: boolean;
  run: RunMeta | undefined;
  /** Every run (agent session) this task has had — newest first — so the detail modal can
   * list them and let you jump into any session's log/review, not just the latest one. */
  runs: RunMeta[];
  /** All epics in the project, for the editable Epic (parent) picker. */
  epics: TaskDoc[];
  /** All tasks in the project, for the editable Blocked-by picker (self is filtered out) and
   * for `StackRail` to derive this task's stack. */
  tasks: TaskDoc[];
  /** Every task's latest run, for `StackRail`'s per-row run/PR chip. */
  latestRunByTaskId: Map<string, RunMeta>;
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  /** Optimistic status change (see `useDispatchProject.moveTaskStatus`) — the same one the
   * board's drag-and-drop uses, so moving a task's status from this dialog's select feels as
   * immediate as dragging its card, rather than waiting on a round-trip like every other field
   * here (`onUpdate`) does. */
  onMoveStatus: (id: string, status: string) => Promise<void>;
  onDispatch: (
    id: string,
    executor?: 'fake' | 'claude',
    model?: string
  ) => Promise<void>;
  onOpenRun: (runId: string) => void;
  /** Starts an AI draft that adds the context an under-specified task is missing. Optional so
   * the older call sites that never had it keep compiling with the button hidden. */
  onEnrich?: (id: string) => Promise<void>;
  /** The plan carrying that draft, passed only while it belongs to *this* task. The caller
   * owns the slot, so a draft survives the dialog being closed and reopened. */
  enrichPlan?: PlanRecord;
  /** Drops the draft without applying it (Discard, and the cleanup after Apply). */
  onDismissEnrich?: () => void;
  /** Answers the enrich planner's clarifying questions on the same plan. Optional, like the
   * other enrich props, so older call sites keep compiling. */
  onAnswerEnrich?: (message: string) => Promise<void>;
  /** Re-points this dialog at a different task — e.g. clicking another task in `StackRail`.
   * Omitted (the palette/board's older call sites) hides the rail's title links, rendering
   * them as plain text instead. */
  onOpenTask?: (taskId: string) => void;
  /** Navigates to `ImpactView` with this task preselected — the Impact section's "open in
   * Impact" action. Optional, like `onOpenTask`, so older call sites keep compiling. */
  onOpenImpact?: (subject: ImpactSubjectRef) => void;
  /** Issue UUID -> display identifier/URL, for turning `doc.meta.external` into a real chip. */
  linearLinks: Record<string, LinearIssueLink>;
  /** Whether Linear is connected with a team chosen — gates the "Push to Linear" action. */
  linearConfigured: boolean;
  /** Pushes this task to Linear now (creating the issue if unlinked). Optional so a caller
   * without Linear plumbing gets no push affordance. */
  onPushToLinear?: (id: string) => Promise<LinearSyncSummary>;
  /** The dispatchd client — this dialog fetches its own findings/fix-loop/
   * verification/ledger data rather than going through the app-level hook. */
  client: ApiClient | null;
  /** The active project's daemon port, for namespacing this dialog's own
   * query keys — see useOrchestration.ts. */
  port: number | undefined;
  /** The project's escalation ladder, for the "fresh implementer" hint. */
  fixLoopEscalation: EscalationStep[];
}

/**
 * Task detail as a wide, two-column shadcn `Dialog`, built to Linear's issue-detail anatomy: a
 * roomy main column (the title as the one loud element, then inline-editable Description /
 * Acceptance Criteria, Sessions, and Activity) beside a narrow right-hand *properties rail*
 * where status, priority, assignee, epic, blockers, and labels are all editable as compact
 * icon+value rows instead of boxed form fields. Every field on the task is editable in place:
 * frontmatter fields go through `onUpdate`/`onMoveStatus`, and the free-text body sections go
 * through `onUpdate`'s `description`/`acceptanceCriteria` (whole-section replacements — see
 * core's setSection). Linear opens issues as a modal (not a side panel), so this stays a
 * centered `Dialog` and owns its own focus trap and Escape handling via Radix.
 */
export function TaskDetailDialog({
  doc,
  statuses,
  ready,
  run,
  runs,
  epics,
  tasks,
  latestRunByTaskId,
  onClose,
  onUpdate,
  onMoveStatus,
  onDispatch,
  onEnrich,
  enrichPlan,
  onDismissEnrich,
  onAnswerEnrich,
  onOpenRun,
  onOpenTask,
  onOpenImpact,
  linearLinks,
  linearConfigured,
  onPushToLinear,
  client,
  port,
  fixLoopEscalation,
}: TaskDetailDialogProps) {
  const [title, setTitle] = useState(doc.meta.title);
  const [activityDraft, setActivityDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [pushingLinear, setPushingLinear] = useState(false);
  // Brief confirmation shown until the tasks cache refetches and `linearLinked` flips the
  // button into the real chip — the push itself gives no other positive signal.
  const [pushedLinear, setPushedLinear] = useState(false);
  // "Add detail" was clicked. Not cleared when the POST resolves — that 202 only means the
  // plan started; it clears when a draft or an error actually arrives.
  const [enrichStarted, setEnrichStarted] = useState(false);
  const [applyingEnrich, setApplyingEnrich] = useState(false);
  // The model this dispatch will use — seeded from the saved default, overridable per-dispatch
  // via the picker beside the Dispatch button.
  const [model, setModel] = useState(readDefaultModel);
  // View-local modal state for this epic's dependency graph — only ever meaningful when
  // `doc.meta.kind === 'epic'`; not lifted to App-level nav state since nothing outside this
  // dialog needs to know the graph is open.
  const [showGraph, setShowGraph] = useState(false);

  // If the link never arrives, drop back to the button rather than claiming "Pushed" forever.
  useEffect(() => {
    if (!pushedLinear) return;
    const timer = setTimeout(() => setPushedLinear(false), 15_000);
    return () => clearTimeout(timer);
  }, [pushedLinear]);

  // Derived from the run's own state, not the task's status string: the old check compared
  // `doc.meta.status` against the literal built-in strings `'in-progress'`/`'in-review'`,
  // which silently stopped working for any project whose `.dispatch/config.yml` names its
  // in-flight statuses something else. A run that isn't in a terminal state *is* an "open
  // run" regardless of what the task's own status happens to be called.
  const hasOpenRun = run !== undefined && !isTerminalRunState(run.state);

  // The Linear issue this task is linked to, if any — null both when unlinked and when linked
  // but the display map has no entry for its UUID yet.
  const linearLink = resolveLinearLink(doc.meta.external, linearLinks);
  const linearLinked = parseExternal(doc.meta.external) !== null;

  const { findings, error: findingsError } = useTaskFindings(
    client,
    port,
    doc.meta.id
  );
  const { fixLoop, error: fixLoopError } = useFixLoop(
    client,
    port,
    doc.meta.id
  );
  const { result: verification, error: verificationError } =
    useTaskVerification(client, port, doc.meta.id);
  const isEpic = doc.meta.kind === 'epic';
  // Only ever meaningful for an epic — `useEpicLedger` no-ops (empty,
  // disabled) when `epicId` is undefined, so this is safe on a plain task.
  const { entries: epicLedgerEntries, error: epicLedgerError } = useEpicLedger(
    client,
    port,
    isEpic ? doc.meta.id : undefined
  );
  // A plain task's own entries live in the project-wide bucket instead, which
  // is the only place a scope grant on an epic-less task is ever recorded.
  const { entries: projectLedger, error: projectLedgerError } =
    useProjectLedger(client, port, !isEpic);
  const ledgerEntries = isEpic
    ? epicLedgerEntries
    : taskLedgerEntries(projectLedger, doc.meta.id);
  const ledgerError = isEpic ? epicLedgerError : projectLedgerError;
  const adjudicateFinding = useAdjudicateFinding(client, port);

  async function pushToLinear() {
    if (onPushToLinear === undefined) return;
    setPushingLinear(true);
    setError(null);
    try {
      const failure = pushToLinearError(await onPushToLinear(doc.meta.id));
      if (failure !== null) setError(failure);
      else setPushedLinear(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushingLinear(false);
    }
  }

  // Whether this task belongs to a stack (a connected chain of blockedBy edges) — gates
  // whether the "Stack" rail section renders at all, so a lone task (the common case) never
  // shows an empty heading with nothing beneath it.
  const stack = useMemo(
    () => computeStack(tasks, doc.meta.id),
    [tasks, doc.meta.id]
  );

  // This epic's children, for the "View graph" button — only ever read when
  // `doc.meta.kind === 'epic'`, but cheap enough to always derive rather than branch the memo.
  const epicChildren = useMemo(
    () => tasks.filter((t) => t.meta.parent === doc.meta.id),
    [tasks, doc.meta.id]
  );

  // The caller only passes `enrichPlan` when it belongs to this task, so no id check here.
  const enrichDraft = enrichDraftFromPlan(enrichPlan);
  const enrichError = enrichPlanError(enrichPlan);
  // The `running` arm covers reopening this (per-task keyed, so remounted) dialog mid-pass,
  // where `enrichStarted` is back to false but the app-level plan is still going.
  // Open questions mean the planner is waiting on the user, not still reading.
  const awaitingEnrichAnswer = (enrichPlan?.questions.length ?? 0) > 0;
  const enriching =
    enrichPlan?.state === 'running' ||
    (enrichStarted &&
      !awaitingEnrichAnswer &&
      enrichDraft === null &&
      enrichError === null);

  async function enrich() {
    if (onEnrich === undefined) return;
    setEnrichStarted(true);
    setError(null);
    try {
      await onEnrich(doc.meta.id);
    } catch (err) {
      setEnrichStarted(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function dismissEnrich() {
    setEnrichStarted(false);
    onDismissEnrich?.();
  }

  // Writes the draft through the ordinary update path. Only dropped once that write lands, so
  // a failed save leaves the proposal on screen to retry.
  async function applyEnrich() {
    if (enrichDraft === null) return;
    setApplyingEnrich(true);
    setError(null);
    try {
      await onUpdate(doc.meta.id, enrichPatch(enrichDraft));
      dismissEnrich();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingEnrich(false);
    }
  }

  async function dispatch(executor?: 'fake' | 'claude') {
    setDispatching(true);
    setError(null);
    try {
      await onDispatch(
        doc.meta.id,
        executor,
        executor === 'fake' ? undefined : model
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  }

  useEffect(() => {
    setTitle(doc.meta.title);
    setActivityDraft('');
    setError(null);
  }, [doc.meta.id, doc.meta.title]);

  const runUpdate = useCallback(
    async (patch: UpdatePatch) => {
      try {
        setError(null);
        await onUpdate(doc.meta.id, patch);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [doc.meta.id, onUpdate]
  );

  const changeStatus = useCallback(
    async (status: string) => {
      try {
        setError(null);
        await onMoveStatus(doc.meta.id, status);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [doc.meta.id, onMoveStatus]
  );

  const saveTitleIfChanged = useCallback(() => {
    if (title.trim() !== '' && title !== doc.meta.title) {
      void runUpdate({ title });
    }
  }, [title, doc.meta.title, runUpdate]);

  // Escape closes the dialog via Radix's own handling (which unmounts this component through
  // `onClose`/`onOpenChange`) — a plain `onBlur` on the title input can't be relied on to fire
  // before that unmount (removing a focused node's blur behavior is inconsistent enough across
  // browsers/webviews to not build a save on), so this listens for Escape itself and commits
  // the in-progress title edit explicitly. The choice here is to commit, not discard, on
  // Escape-while-editing — matching every other control on this dialog (status/priority
  // selects, activity notes), which all save immediately rather than needing a separate "save"
  // step.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') saveTitleIfChanged();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [saveTitleIfChanged]);

  function submitActivity() {
    if (activityDraft.trim() !== '') {
      void runUpdate({ appendActivity: activityDraft.trim() });
      setActivityDraft('');
    }
  }

  // Existing milestone names across the project, for the rail's pick-or-type field.
  const milestones = [
    ...new Set(
      tasks
        .map((t) => t.meta.milestone)
        .filter((m): m is string => m !== null && m !== '')
    ),
  ].sort();

  const sections = parseTaskSections(doc.body);
  const description = sections.get('Description') ?? '';
  const acceptance = sections.get('Acceptance Criteria') ?? '';
  const amendments = sections.get('Amendments') ?? '';
  // The Activity section body is append-only free text, one line per entry (see
  // core/store.ts's template) — split it into a feed of entries rather than one flat block.
  const activityEntries = (sections.get('Activity') ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          className="flex h-[85vh] max-h-[760px] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]"
          aria-describedby={undefined}
          // Radix's default open-autofocus lands on the first tabbable descendant — which is
          // the (pre-filled) title field — and browsers select a text input's full value when
          // it's focused this way, not just place a caret. Left alone, opening this dialog and
          // pressing any key (even Space) would silently wipe the task's title. Focus the
          // content root itself instead (Radix gives it `tabIndex={-1}` for exactly this) —
          // Tab still reaches the title field normally, just without the drive-by select-all.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
        >
          <ErrorBoundary label="this dialog">
            {/* Breadcrumb-style header, matching Linear's `Team › Issues › ID`: just the id and
            live status, quiet, above the two-column body. */}
            <div className="border-border flex shrink-0 items-center gap-2 border-b px-6 py-3">
              <span className="text-muted-foreground font-mono text-[11px]">
                {doc.meta.id}
              </span>
              <span className="text-muted-foreground/40">›</span>
              <StatusIcon status={doc.meta.status} />
              <span className="text-muted-foreground text-[12px]">
                {doc.meta.status}
              </span>
              <span className="text-muted-foreground/40">›</span>
              <MergeLadderDot meta={run} />
              <span className="text-muted-foreground text-[12px]">
                {mergeLadderLabel(
                  mergeLadderState(run),
                  run?.branch,
                  run?.mergeCommit,
                  run?.prUrl
                )}
              </span>
              {linearLinked && (
                <>
                  <span className="text-muted-foreground/40">›</span>
                  {linearLink !== null ? (
                    <a
                      href={linearLink.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Badge variant="outline" className="gap-1 text-[11px]">
                        <Link2 className="size-3" />
                        {linearLink.identifier}
                      </Badge>
                    </a>
                  ) : (
                    // The display map has no entry for this UUID yet (a baseline pass hasn't
                    // covered it) — say "linked" without naming or linking to the issue.
                    <Badge
                      variant="outline"
                      className="gap-1 text-[11px]"
                      title="Linked to a Linear issue"
                    >
                      <Link2 className="size-3" />
                      Linear
                    </Badge>
                  )}
                </>
              )}
              {!linearLinked &&
                linearConfigured &&
                onPushToLinear !== undefined && (
                  <>
                    <span className="text-muted-foreground/40">›</span>
                    {pushedLinear ? (
                      <span className="text-state-review inline-flex items-center gap-1 text-[11px]">
                        <Link2 className="size-3" />
                        Pushed
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void pushToLinear();
                        }}
                        disabled={pushingLinear}
                        className="text-muted-foreground hover:text-foreground h-auto gap-1 p-0 text-[11px] hover:bg-transparent has-[>svg]:px-0"
                      >
                        <Link2 className="size-3" />
                        {pushingLinear ? 'Pushing…' : 'Push to Linear'}
                      </Button>
                    )}
                  </>
                )}
              <DialogTitle className="sr-only">
                {doc.meta.title || 'Task detail'}
              </DialogTitle>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Main column: the title leads, then dispatch actions, editable prose sections,
              sessions, and the activity feed + composer — all left-aligned in a roomy flow. */}
              <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6">
                {error !== null && (
                  <Alert
                    variant="destructive"
                    className="bg-destructive/10 rounded-md border-0 px-3 py-2 text-[13px]"
                  >
                    <AlertDescription className="text-[13px]">
                      {error}
                    </AlertDescription>
                  </Alert>
                )}

                <Input
                  className="text-foreground hover:bg-muted/40 dark:hover:bg-muted/40 -mx-2 h-auto w-[calc(100%+1rem)] border-transparent bg-transparent px-2 py-1 text-[22px] leading-tight font-semibold shadow-none transition-colors duration-150 dark:bg-transparent"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={saveTitleIfChanged}
                  aria-label="Task title"
                />

                {doc.meta.kind === 'epic' && (
                  <div className="-mt-2 flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowGraph(true)}
                    >
                      <Waypoints className="size-3.5" />
                      View graph
                    </Button>
                  </div>
                )}

                {ledgerError !== null && (
                  <Alert
                    variant="destructive"
                    className="border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-[12.5px]"
                  >
                    <AlertDescription className="text-[12.5px]">
                      Couldn&rsquo;t load the ledger: {ledgerError}
                    </AlertDescription>
                  </Alert>
                )}
                <LedgerSection entries={ledgerEntries} />

                {onEnrich !== undefined && (
                  <div className="-mt-2 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      {/* Deliberately outside the ready/hasOpenRun gate below: a blocked or
                      not-yet-ready task is precisely the one worth specifying properly before
                      an agent ever gets to it. */}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={enriching}
                        onClick={() => void enrich()}
                      >
                        <Sparkles className="size-3.5" />
                        {enriching ? 'Reading the repo…' : 'Add detail'}
                      </Button>
                      {enrichError !== null && (
                        <span className="text-state-failed text-[12.5px]">
                          {enrichError}
                        </span>
                      )}
                    </div>

                    {enrichPlan !== undefined &&
                      enrichPlan.questions.length > 0 &&
                      onAnswerEnrich !== undefined && (
                        <PlanQuestionsForm
                          questions={enrichPlan.questions}
                          disabled={enrichPlan.state === 'running'}
                          onSend={onAnswerEnrich}
                        />
                      )}

                    {enrichDraft !== null && (
                      <EnrichReview
                        draft={enrichDraft}
                        applying={applyingEnrich}
                        onApply={() => void applyEnrich()}
                        onDiscard={dismissEnrich}
                      />
                    )}
                  </div>
                )}
                {(ready || hasOpenRun) && (
                  <div className="-mt-2 flex items-center gap-2">
                    {ready && (
                      <>
                        <Button
                          size="sm"
                          disabled={dispatching}
                          onClick={() => void dispatch()}
                        >
                          Dispatch
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              className="text-muted-foreground hover:bg-muted/60 hover:text-foreground h-auto gap-1 rounded-md border border-transparent px-2 py-1 text-[12px] has-[>svg]:px-2"
                            >
                              {modelLabel(model)}
                              <ChevronDown className="size-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            {MODELS.map((m) => (
                              <DropdownMenuItem
                                key={m.id}
                                onSelect={() => setModel(m.id)}
                                className="gap-2 pr-8 text-[13px]"
                              >
                                <span className="flex-1">{m.label}</span>
                                {m.id === model && (
                                  <Check className="ml-auto size-3.5" />
                                )}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                    {ready && isFakeExecutorDevToolEnabled() && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={dispatching}
                        onClick={() => void dispatch('fake')}
                      >
                        Dispatch (fake)
                      </Button>
                    )}
                    {hasOpenRun && run !== undefined && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onOpenRun(run.id)}
                      >
                        {doc.meta.status === 'in-review'
                          ? 'Review run'
                          : 'View run'}
                      </Button>
                    )}
                    {run?.prUrl !== undefined && (
                      <a href={run.prUrl} target="_blank" rel="noreferrer">
                        <Badge
                          variant="outline"
                          className="text-primary hover:bg-accent gap-1 rounded-full px-2 py-1 text-[11px] transition-colors duration-150"
                        >
                          PR
                          <ArrowUpRight className="size-3" />
                        </Badge>
                      </a>
                    )}
                  </div>
                )}

                {fixLoopError !== null && (
                  <Alert
                    variant="destructive"
                    className="border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-[12.5px]"
                  >
                    <AlertDescription className="text-[12.5px]">
                      Couldn&rsquo;t load the fix loop: {fixLoopError}
                    </AlertDescription>
                  </Alert>
                )}
                {fixLoop !== null && (
                  <FixLoopSection
                    fixLoop={fixLoop}
                    escalation={fixLoopEscalation}
                  />
                )}

                {findingsError !== null && (
                  <Alert
                    variant="destructive"
                    className="border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-[12.5px]"
                  >
                    <AlertDescription className="text-[12.5px]">
                      Couldn&rsquo;t load findings: {findingsError}
                      {fixLoopNeedsRuling(fixLoop) &&
                        ' Open findings can’t be ruled on right now.'}
                    </AlertDescription>
                  </Alert>
                )}
                <FindingsPanel
                  findings={findings}
                  needsRuling={fixLoopNeedsRuling(fixLoop)}
                  onAdjudicate={async (findingId, input) => {
                    await adjudicateFinding(doc.meta.id, findingId, input);
                  }}
                />

                <EditableBodySection
                  title="Description"
                  value={description}
                  placeholder="Add a description…"
                  onSave={(next) => void runUpdate({ description: next })}
                />

                <EditableBodySection
                  title="Acceptance Criteria"
                  value={acceptance}
                  placeholder="Add acceptance criteria…"
                  onSave={(next) =>
                    void runUpdate({ acceptanceCriteria: next })
                  }
                />

                {amendments !== '' && (
                  <MainSection title="Amendments">
                    <p className="text-muted-foreground text-[13px] whitespace-pre-wrap">
                      {amendments}
                    </p>
                  </MainSection>
                )}

                <MainSection
                  title={`Sessions${runs.length > 0 ? ` · ${runs.length}` : ''}`}
                >
                  {runs.length === 0 ? (
                    <p className="text-muted-foreground text-[13px]">
                      No agent has worked this task yet.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {runs.map((r) => (
                        <li key={r.id}>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenRun(r.id)}
                            className="border-border/60 hover:bg-muted/60 h-auto w-full justify-start gap-2 rounded-md border px-2.5 py-1.5 text-left"
                          >
                            <RunStatePill meta={r} />
                            <span className="text-muted-foreground font-mono text-[11px]">
                              {r.id}
                            </span>
                            <span className="text-muted-foreground/70 ml-auto text-[11px] whitespace-nowrap">
                              {r.costUsd !== undefined &&
                                `$${r.costUsd.toFixed(2)} · `}
                              {formatRelativeTimeFromIso(r.updatedAt)}
                            </span>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </MainSection>

                <VerificationSection
                  exercised={doc.meta.exercised}
                  result={verification}
                  error={verificationError}
                />

                <MainSection title="Impact">
                  <div className="flex flex-col items-start gap-2">
                    <ImpactPanel
                      client={client}
                      subject="task"
                      id={doc.meta.id}
                    />
                    {onOpenImpact !== undefined && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          onOpenImpact({ kind: 'task', id: doc.meta.id })
                        }
                      >
                        <Waypoints className="size-3.5" />
                        Open in Impact
                      </Button>
                    )}
                  </div>
                </MainSection>

                <MainSection title="Activity">
                  {activityEntries.length === 0 ? (
                    <p className="text-muted-foreground text-[13px]">
                      No activity yet.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {activityEntries.map((entry, i) => (
                        <li
                          key={i}
                          className="text-muted-foreground text-[13px] whitespace-pre-wrap"
                        >
                          {entry}
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* Linear-style comment composer: one bordered, rounded box that focuses as a
                  unit, with the send affordance tucked inside on the right. */}
                  <div className="border-border focus-within:border-ring/60 mt-1 flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors duration-150">
                    <Input
                      className="h-7 flex-1 border-transparent bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
                      placeholder="Leave a note…"
                      value={activityDraft}
                      onChange={(e) => setActivityDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitActivity();
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={activityDraft.trim() === ''}
                      onClick={submitActivity}
                    >
                      Add
                    </Button>
                  </div>
                </MainSection>
              </div>

              {/* Properties rail: the signature Linear element — every property editable in place
              as a compact icon+value row (ghost selects) or chip editor, grouped under quiet
              headers, instead of a grid of boxed form fields. */}
              <aside className="border-border bg-muted/20 w-[248px] shrink-0 overflow-y-auto border-l px-4 py-6">
                <div className="flex flex-col gap-5">
                  <RailSection title="Properties">
                    <StatusControl
                      value={doc.meta.status}
                      statuses={statuses}
                      onChange={(s) => void changeStatus(s)}
                      variant="row"
                    />
                    <PriorityControl
                      value={doc.meta.priority}
                      onChange={(p) => void runUpdate({ priority: p })}
                      variant="row"
                    />
                    <AssigneeControl
                      value={doc.meta.assignee}
                      onChange={(a) => void runUpdate({ assignee: a })}
                      variant="row"
                    />
                    <EpicControl
                      value={doc.meta.parent}
                      epics={epics}
                      onChange={(parent) => void runUpdate({ parent })}
                      variant="row"
                    />

                    <MilestoneRow
                      value={doc.meta.milestone}
                      milestones={milestones}
                      onChange={(milestone) => void runUpdate({ milestone })}
                    />

                    <SelfReviewRow
                      value={doc.meta.selfReview}
                      onChange={(selfReview) => void runUpdate({ selfReview })}
                    />

                    {/* Kind is fixed at creation (task vs epic) — the one property that stays
                    read-only, shown for context alongside the editable rows. */}
                    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
                      <Layers className="text-muted-foreground size-3.5" />
                      <span>{doc.meta.kind}</span>
                    </div>
                  </RailSection>

                  <RailSection title="Blocked by">
                    {doc.meta.blockedBy.length === 0 && (
                      <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-[13px]">
                        <Ban className="size-3.5" />
                        No blockers
                      </div>
                    )}
                    <BlockedByEditor
                      blockedBy={doc.meta.blockedBy}
                      candidates={tasks.filter(
                        (t) => t.meta.id !== doc.meta.id
                      )}
                      onChange={(next) => void runUpdate({ blockedBy: next })}
                    />
                  </RailSection>

                  {/* Gated on `stack` (not just letting `StackRail` render null on its own) so a
                  lone task — the common case, not a "stack" of one — never shows an empty
                  "Stack" heading with nothing beneath it. */}
                  {stack !== null && (
                    <RailSection title="Stack">
                      <StackRail
                        tasks={tasks}
                        taskId={doc.meta.id}
                        latestRunByTaskId={latestRunByTaskId}
                        onOpenTask={onOpenTask}
                      />
                    </RailSection>
                  )}

                  <RailSection title="Labels">
                    {doc.meta.labels.length === 0 && (
                      <div className="text-muted-foreground flex items-center gap-2 px-2 pb-0.5 text-[13px]">
                        <Tag className="size-3.5" />
                        No labels
                      </div>
                    )}
                    <LabelEditor
                      labels={doc.meta.labels}
                      onChange={(next) => void runUpdate({ labels: next })}
                    />
                  </RailSection>
                </div>
              </aside>
            </div>
          </ErrorBoundary>
        </DialogContent>
      </Dialog>

      {doc.meta.kind === 'epic' && (
        <EpicDagModal
          epic={showGraph ? doc : null}
          tasks={epicChildren}
          onOpenTask={onOpenTask}
          onClose={() => setShowGraph(false)}
        />
      )}
    </>
  );
}
