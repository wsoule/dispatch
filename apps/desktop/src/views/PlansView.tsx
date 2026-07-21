import type { PlannedTask, PlanProposal, PlanState } from '@dispatch/client';
import { reduceProposal } from '@dispatch/client';
import type { Priority } from '@dispatch/core';
import {
  AlertTriangle,
  Check,
  CircleAlert,
  History,
  Link2,
  Loader2,
  Minus,
  Send,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

interface PlanHistoryEntry {
  id: string;
  prompt: string;
  createdAt: string;
  state: PlanState | 'unknown';
}

/** dispatchd has no "list every plan" endpoint (each plan is fetched by id) — history is
 * this window's own session record of prompts it started, persisted to localStorage per
 * project so switching views (or a reload) doesn't lose it. This is a deliberate scope cut
 * from a server-backed plan history; see the phase-8 report for the tradeoff. */
function historyStorageKey(projectPath: string): string {
  return `dispatch:planHistory:${projectPath}`;
}

function loadHistory(projectPath: string): PlanHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(historyStorageKey(projectPath));
    return raw !== null ? (JSON.parse(raw) as PlanHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(projectPath: string, history: PlanHistoryEntry[]): void {
  try {
    window.localStorage.setItem(
      historyStorageKey(projectPath),
      JSON.stringify(history)
    );
  } catch {
    // Best-effort — a full/disabled localStorage just means history doesn't persist across
    // reloads this session, not a reason to break the plan flow itself.
  }
}

/** Small color-coded lucide icon in place of a text pill — only urgent/high get a color
 * treatment (matches `priorityTone`'s "don't compete for attention" rule elsewhere in the
 * app); medium/low/none stay a muted, silent icon shape. */
function PriorityIcon({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}) {
  switch (priority) {
    case 'urgent':
      return <AlertTriangle className={cn('text-destructive', className)} />;
    case 'high':
      return (
        <SignalHigh
          className={cn('text-amber-500 dark:text-amber-400', className)}
        />
      );
    case 'medium':
      return (
        <SignalMedium className={cn('text-muted-foreground', className)} />
      );
    case 'low':
      return <SignalLow className={cn('text-muted-foreground', className)} />;
    case 'none':
      return <Minus className={cn('text-muted-foreground/60', className)} />;
  }
}

/** Small colored dot for a history entry's plan state — the brief's "status = a dot, not a
 * text pill" rule. `running` pulses (mirrors the Board's live-run pulse) since it's the one
 * state that's actively changing underneath the user. */
function PlanStateDot({ state }: { state: PlanHistoryEntry['state'] }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'ready' && 'bg-emerald-500',
        state === 'failed' && 'bg-destructive',
        state === 'running' && 'bg-primary animate-pulse',
        state === 'unknown' && 'bg-muted-foreground/40'
      )}
    />
  );
}

interface PlanTaskRowProps {
  task: PlannedTask;
  index: number;
  allTasks: PlannedTask[];
  onEdit: (index: number, patch: Partial<PlannedTask>) => void;
  onRemove: (index: number) => void;
}

/** One card of the proposal review list. "Dependency arrows" are rendered as a plain
 * "blocked by …" badge line naming the blocking tasks by their (possibly just-edited)
 * title — a real arrow-diagram would need a layout engine this view doesn't have yet; the
 * badges convey the same ordering information, and titles are looked up live off the current
 * draft so an edited blocker's new title shows immediately in its dependents' rows. */
function PlanTaskRow({
  task,
  index,
  allTasks,
  onEdit,
  onRemove,
}: PlanTaskRowProps) {
  const blockerTitles = task.blockedByIndices
    .map((i) => allTasks[i]?.title)
    .filter((title): title is string => title !== undefined);

  return (
    <div className="border-border bg-card hover:border-muted-foreground/30 flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-150">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-5 shrink-0 font-mono text-[11px]">
          {index + 1}
        </span>
        <Select
          value={task.priority}
          onValueChange={(value) =>
            onEdit(index, { priority: value as Priority })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={`Task ${index + 1} priority`}
            className="h-7 w-[112px] gap-1.5 px-2 text-[12px]"
          >
            <PriorityIcon priority={task.priority} className="size-3.5" />
            <SelectValue className="capitalize" />
          </SelectTrigger>
          <SelectContent align="start">
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                <PriorityIcon priority={p} className="size-3.5" />
                <span className="capitalize">{p}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onRemove(index)}
          aria-label={`Remove task ${index + 1}`}
          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <Input
        value={task.title}
        onChange={(e) => onEdit(index, { title: e.target.value })}
        aria-label={`Task ${index + 1} title`}
        className="focus-visible:ring-ring/40 h-auto border-none bg-transparent px-0 py-0.5 text-[13px] font-medium shadow-none focus-visible:ring-1"
      />
      <Textarea
        rows={2}
        value={task.description}
        onChange={(e) => onEdit(index, { description: e.target.value })}
        aria-label={`Task ${index + 1} description`}
        className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 py-0.5 text-[12px] shadow-none focus-visible:ring-1"
      />

      {blockerTitles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <Link2 className="text-muted-foreground size-3" />
          <span className="text-muted-foreground text-[11px]">Blocked by</span>
          {blockerTitles.map((title, i) => (
            <Badge
              key={`${title}-${i}`}
              variant="secondary"
              className="max-w-[12rem] truncate font-normal"
            >
              {title}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

interface PlansViewProps {
  data: DispatchProjectData;
  projectPath: string;
}

/**
 * The plan-work flow as its own primary view rather than a modal: a composer at top
 * ("Describe the work…"), this session's plan history below it, and — once a plan resolves
 * — an editable proposal review list, in place of the composer.
 */
export function PlansView({ data, projectPath }: PlansViewProps) {
  const [history, setHistory] = useState<PlanHistoryEntry[]>(() =>
    loadHistory(projectPath)
  );
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanProposal | null>(null);
  // Stable per-row identity for `draft.tasks`, kept in lockstep with it (same length, same
  // order) — index-based keys would make React reuse a row's DOM node/focus/scroll position
  // for whatever task slides into that index after `removeTask` splices one out, which reads
  // as a row's in-progress edit jumping to a different task.
  const [taskKeys, setTaskKeys] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Keeps the visible history entry's state snapshot fresh whenever the currently-open
  // plan's record changes (running -> ready/failed), and seeds the editable draft the
  // moment a proposal is ready.
  useEffect(() => {
    if (data.planId === null || data.planRecord === undefined) return;
    const planRecord = data.planRecord;
    setHistory((prev) => {
      const next = prev.map((entry) =>
        entry.id === data.planId ? { ...entry, state: planRecord.state } : entry
      );
      saveHistory(projectPath, next);
      return next;
    });
    if (planRecord.state === 'ready' && planRecord.proposal) {
      const proposal = planRecord.proposal;
      setDraft((prev) => prev ?? proposal);
      setTaskKeys((prev) =>
        prev.length === 0
          ? proposal.tasks.map((_, i) => `plan-task-${data.planId}-${i}`)
          : prev
      );
    }
  }, [data.planId, data.planRecord, projectPath]);

  async function submitPrompt() {
    if (prompt.trim() === '') return;
    setSubmitting(true);
    setSubmitError(null);
    setDraft(null);
    setTaskKeys([]);
    try {
      const newPlanId = await data.handleSubmitPrompt(prompt.trim());
      const entry: PlanHistoryEntry = {
        id: newPlanId,
        prompt: prompt.trim(),
        createdAt: new Date().toISOString(),
        state: 'running',
      };
      setHistory((prev) => {
        const next = [entry, ...prev];
        saveHistory(projectPath, next);
        return next;
      });
      setPrompt('');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function editTask(index: number, patch: Partial<PlannedTask>) {
    setDraft((prev) => {
      if (prev === null) return prev;
      const tasks = prev.tasks.map((t, i) =>
        i === index ? { ...t, ...patch } : t
      );
      return { ...prev, tasks };
    });
  }

  function removeTask(index: number) {
    setDraft((prev) =>
      prev === null ? prev : reduceProposal(prev, { type: 'removeTask', index })
    );
    setTaskKeys((prev) => prev.filter((_, i) => i !== index));
  }

  async function submitConfirm() {
    if (draft === null) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await data.handleConfirmPlan(draft);
      setDraft(null);
      setTaskKeys([]);
      data.setPlanId(null);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  function openHistoryEntry(entry: PlanHistoryEntry) {
    setDraft(null);
    // Cleared here too (not just on submitPrompt) — switching to a *different* history entry
    // must not carry over the previous entry's row keys onto this one's tasks.
    setTaskKeys([]);
    setConfirmError(null);
    data.setPlanId(entry.id);
  }

  const showProposalTable =
    draft !== null && data.planRecord?.state === 'ready';

  // A composer that submits against a dead daemon would just hang on "Starting…" forever
  // (`handleSubmitPrompt` throws once `client` is null, but only *after* the click) — show
  // the same daemon-unavailable state every other primary view shows instead of a live
  // composer with nothing behind it (I4).
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const planIsPending =
    data.planId !== null &&
    !showProposalTable &&
    (data.planRecord === undefined || data.planRecord.state === 'running');

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-6">
      <h1 className="view-topbar-title">Plans</h1>

      {!showProposalTable && (
        <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-3 rounded-lg border p-4 duration-150">
          {submitError !== null && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
          <Textarea
            rows={4}
            placeholder="Describe the work — the planner will propose an epic and its tasks…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="resize-y text-[13px]"
          />
          <div className="flex justify-end">
            <Button
              disabled={submitting || prompt.trim() === ''}
              onClick={() => void submitPrompt()}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <Send className="size-4" /> Plan work…
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {planIsPending && (
        <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-3 rounded-lg border p-4 duration-150">
          <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <Loader2 className="text-primary size-4 animate-spin" />
            <span>
              Planning — the agent is reading the codebase and drafting an epic
              and its tasks. This can take a minute.
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        </div>
      )}

      {data.planId !== null && data.planRecord?.state === 'failed' && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive animate-in fade-in-0 flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] duration-150">
          <CircleAlert className="size-4 shrink-0" />
          <span>
            Planning failed
            {data.planRecord.error ? `: ${data.planRecord.error}` : '.'}
          </span>
        </div>
      )}

      {showProposalTable && draft !== null && (
        <div className="animate-in fade-in-0 flex flex-col gap-4 duration-150">
          {confirmError !== null && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{confirmError}</span>
            </div>
          )}

          {draft.epic !== undefined && (
            <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4">
              <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Epic
              </div>
              <Input
                value={draft.epic.title}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev === null
                      ? prev
                      : reduceProposal(prev, {
                          type: 'setEpicTitle',
                          title: e.target.value,
                        })
                  )
                }
                aria-label="Epic title"
                className="focus-visible:ring-ring/40 h-auto border-none bg-transparent px-0 text-[14px] font-medium shadow-none focus-visible:ring-1"
              />
              <Textarea
                rows={2}
                value={draft.epic.description}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev === null
                      ? prev
                      : reduceProposal(prev, {
                          type: 'setEpicDescription',
                          description: e.target.value,
                        })
                  )
                }
                aria-label="Epic description"
                className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-1"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            {draft.tasks.map((task, i) => (
              <PlanTaskRow
                key={taskKeys[i] ?? i}
                task={task}
                index={i}
                allTasks={draft.tasks}
                onEdit={editTask}
                onRemove={removeTask}
              />
            ))}
          </div>

          <div className="border-border flex items-center justify-end gap-2 border-t pt-3">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setTaskKeys([]);
                data.setPlanId(null);
              }}
              disabled={confirming}
            >
              Cancel
            </Button>
            <Button
              disabled={confirming || draft.tasks.length === 0}
              onClick={() => void submitConfirm()}
            >
              {confirming ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Creating…
                </>
              ) : (
                <>
                  <Check className="size-4" /> Confirm {draft.tasks.length}{' '}
                  tasks
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          History
        </div>
        {history.length === 0 ? (
          <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
            <History className="text-muted-foreground size-5" />
            <p className="text-muted-foreground text-[13px]">
              No plans started yet this session.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => openHistoryEntry(entry)}
                className={cn(
                  'border-border bg-card hover:border-muted-foreground/30 flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors duration-150',
                  entry.id === data.planId && 'border-primary/40 bg-accent'
                )}
              >
                <PlanStateDot state={entry.state} />
                <span className="min-w-0 flex-1 truncate">{entry.prompt}</span>
                <span className="text-muted-foreground shrink-0 text-[11px] capitalize">
                  {entry.state}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
