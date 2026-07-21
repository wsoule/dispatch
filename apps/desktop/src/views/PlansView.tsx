import type { PlannedTask, PlanProposal, PlanState } from '@dispatch/client';
import { reduceProposal } from '@dispatch/client';
import type { Priority } from '@dispatch/core';
import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button';
import { Pill } from '../components/ui/Pill';
import { Select } from '../components/ui/Select';
import { TextInput } from '../components/ui/TextInput';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import './PlansView.css';

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

interface PlanTaskRowProps {
  task: PlannedTask;
  index: number;
  allTasks: PlannedTask[];
  onEdit: (index: number, patch: Partial<PlannedTask>) => void;
  onRemove: (index: number) => void;
}

/** One row of the full-width proposal table. "Dependency arrows" are rendered as a plain
 * "← blocked by …" chip line naming the blocking tasks by their (possibly just-edited)
 * title — a real arrow-diagram would need a layout engine this view doesn't have yet; the
 * chip conveys the same ordering information, and titles are looked up live off the current
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
    <div className="plans-view-task-row">
      <span className="plans-view-task-row-index">{index + 1}</span>
      <div className="plans-view-task-row-main">
        <TextInput
          className="plans-view-task-row-title"
          value={task.title}
          onChange={(e) => onEdit(index, { title: e.target.value })}
          aria-label={`Task ${index + 1} title`}
        />
        <textarea
          className="plans-view-task-row-description"
          rows={2}
          value={task.description}
          onChange={(e) => onEdit(index, { description: e.target.value })}
          aria-label={`Task ${index + 1} description`}
        />
        {blockerTitles.length > 0 && (
          <div className="plans-view-task-row-blocked">
            ← blocked by {blockerTitles.join(', ')}
          </div>
        )}
      </div>
      <Select
        value={task.priority}
        onChange={(e) =>
          onEdit(index, { priority: e.target.value as Priority })
        }
        aria-label={`Task ${index + 1} priority`}
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
      <Button
        variant="secondary"
        onClick={() => onRemove(index)}
        aria-label={`Remove task ${index + 1}`}
      >
        Remove
      </Button>
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
 * — a full-width editable proposal table with a confirm bar, in place of the composer.
 */
export function PlansView({ data, projectPath }: PlansViewProps) {
  const [history, setHistory] = useState<PlanHistoryEntry[]>(() =>
    loadHistory(projectPath)
  );
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanProposal | null>(null);
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
    }
  }, [data.planId, data.planRecord, projectPath]);

  async function submitPrompt() {
    if (prompt.trim() === '') return;
    setSubmitting(true);
    setSubmitError(null);
    setDraft(null);
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
  }

  async function submitConfirm() {
    if (draft === null) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await data.handleConfirmPlan(draft);
      setDraft(null);
      data.setPlanId(null);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  function openHistoryEntry(entry: PlanHistoryEntry) {
    setDraft(null);
    setConfirmError(null);
    data.setPlanId(entry.id);
  }

  const showProposalTable =
    draft !== null && data.planRecord?.state === 'ready';

  return (
    <div className="plans-view">
      <h1 className="view-topbar-title">Plans</h1>

      {!showProposalTable && (
        <div className="plans-view-composer">
          {submitError !== null && (
            <div className="plans-view-error">{submitError}</div>
          )}
          <textarea
            className="plans-view-prompt-input"
            rows={4}
            placeholder="Describe the work — the planner will propose an epic and its tasks…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="plans-view-composer-actions">
            <Button
              disabled={submitting || prompt.trim() === ''}
              onClick={() => void submitPrompt()}
            >
              {submitting ? 'Starting…' : 'Plan work…'}
            </Button>
          </div>
        </div>
      )}

      {data.planId !== null &&
        !showProposalTable &&
        (data.planRecord === undefined ||
          data.planRecord.state === 'running') && (
          <p className="plans-view-status">
            Planning… the agent is reading the codebase and drafting an epic and
            its tasks. This can take a minute.
          </p>
        )}

      {data.planId !== null && data.planRecord?.state === 'failed' && (
        <p className="plans-view-error">
          Planning failed
          {data.planRecord.error ? `: ${data.planRecord.error}` : '.'}
        </p>
      )}

      {showProposalTable && draft !== null && (
        <div className="plans-view-proposal">
          {confirmError !== null && (
            <div className="plans-view-error">{confirmError}</div>
          )}

          {draft.epic !== undefined && (
            <div className="plans-view-epic">
              <TextInput
                className="plans-view-epic-title"
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
              />
              <textarea
                className="plans-view-epic-description"
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
              />
            </div>
          )}

          <div className="plans-view-task-table">
            {draft.tasks.map((task, i) => (
              <PlanTaskRow
                key={i}
                task={task}
                index={i}
                allTasks={draft.tasks}
                onEdit={editTask}
                onRemove={removeTask}
              />
            ))}
          </div>

          <div className="plans-view-confirm-bar">
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
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
              {confirming ? 'Creating…' : `Confirm ${draft.tasks.length} tasks`}
            </Button>
          </div>
        </div>
      )}

      <div className="plans-view-history">
        <div className="plans-view-history-title">History</div>
        {history.length === 0 ? (
          <p className="plans-view-status">
            No plans started yet this session.
          </p>
        ) : (
          history.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`plans-view-history-item${
                entry.id === data.planId ? ' active' : ''
              }`}
              onClick={() => openHistoryEntry(entry)}
            >
              <span className="plans-view-history-item-prompt">
                {entry.prompt}
              </span>
              <Pill
                variant="status"
                tone={
                  entry.state === 'ready'
                    ? 'green'
                    : entry.state === 'failed'
                      ? 'red'
                      : 'gray'
                }
              >
                {entry.state}
              </Pill>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
