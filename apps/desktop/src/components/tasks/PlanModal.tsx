import type { PlannedTask, PlanProposal } from '@dispatch/client';
import { reduceProposal } from '@dispatch/client';
import type { Priority } from '@dispatch/core';
import { useEffect, useState } from 'react';

import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';
import './PlanModal.css';

// Fixed enum, same rationale as TaskDetailModal/CreateTaskModal: mirrors
// core/types.ts's Priority rather than importing it at runtime.
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export type PlanStage = 'compose' | 'running' | 'ready' | 'failed';

interface PlanModalProps {
  stage: PlanStage;
  /** Set only when `stage === 'failed'`. */
  error?: string;
  /** Set only when `stage === 'ready'` (the planner's or, once edited, the person's own draft). */
  proposal?: PlanProposal;
  onSubmitPrompt: (prompt: string) => Promise<void>;
  onConfirm: (proposal: PlanProposal) => Promise<void>;
  onCancel: () => void;
}

// One task row in the review screen: editable title/description/priority,
// a Remove button, and — read-only, derived from the *current* draft rather
// than the original proposal — which other draft tasks (by title) this one
// is blocked by. Titles are looked up fresh on every render so an edited
// blocker's title change is immediately reflected in its dependents' rows.
function TaskEditRow({
  task,
  index,
  allTasks,
  onEdit,
  onRemove,
}: {
  task: PlannedTask;
  index: number;
  allTasks: PlannedTask[];
  onEdit: (index: number, patch: Partial<PlannedTask>) => void;
  onRemove: (index: number) => void;
}) {
  const blockerTitles = task.blockedByIndices
    .map((i) => allTasks[i]?.title)
    .filter((title): title is string => title !== undefined);

  return (
    <div className="plan-modal-task-row">
      <div className="plan-modal-task-row-header">
        <TextInput
          className="plan-modal-task-title"
          value={task.title}
          onChange={(e) => onEdit(index, { title: e.target.value })}
          aria-label={`Task ${index + 1} title`}
        />
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
      <textarea
        className="plan-modal-task-description"
        rows={2}
        value={task.description}
        onChange={(e) => onEdit(index, { description: e.target.value })}
        aria-label={`Task ${index + 1} description`}
      />
      {blockerTitles.length > 0 && (
        <div className="plan-modal-task-blocked-by">
          ← blocked by {blockerTitles.join(', ')}
        </div>
      )}
    </div>
  );
}

/**
 * The whole plan-work flow (spec §5) lives behind one Modal instance that
 * switches its body by `stage`: a prompt composer, a running/spinner state,
 * the editable proposal review screen, or a failure message. One modal
 * rather than four separate ones so the transition between stages (typing a
 * prompt -> waiting -> reviewing) reads as one continuous flow instead of a
 * dialog closing and a different one opening. Nothing here writes anything —
 * confirming just hands the edited proposal back to the caller
 * (TasksPanel), which is the one place that calls `POST /confirm`.
 */
export function PlanModal({
  stage,
  error,
  proposal,
  onSubmitPrompt,
  onConfirm,
  onCancel,
}: PlanModalProps) {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanProposal | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // The proposal only ever arrives once (the planner call resolves exactly
  // once per plan) — this seeds the editable draft the moment it does,
  // without clobbering whatever edits are already in progress on a later
  // render of the same ready proposal.
  useEffect(() => {
    if (proposal !== undefined) setDraft((prev) => prev ?? proposal);
  }, [proposal]);

  function editTask(index: number, patch: Partial<PlannedTask>) {
    setDraft((prev) => {
      if (prev === null) return prev;
      const tasks = prev.tasks.map((t, i) =>
        i === index ? { ...t, ...patch } : t
      );
      return { ...prev, tasks };
    });
  }

  async function submitPrompt() {
    if (prompt.trim() === '') return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmitPrompt(prompt.trim());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
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
      await onConfirm(draft);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  const title = stage === 'ready' ? 'Review plan' : 'Plan work';

  return (
    <Modal isOpen onClose={onCancel} title={title} wide={stage === 'ready'}>
      <div className="plan-modal">
        {stage === 'compose' && (
          <>
            {submitError !== null && (
              <div className="plan-modal-error">{submitError}</div>
            )}
            <label className="plan-modal-field">
              <span className="plan-modal-field-label">
                What do you want built?
              </span>
              <textarea
                className="plan-modal-prompt-input"
                rows={5}
                placeholder="Describe the work — the planner will propose an epic and its tasks…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                autoFocus
              />
            </label>
            <div className="plan-modal-actions">
              <Button
                variant="secondary"
                onClick={onCancel}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                disabled={submitting || prompt.trim() === ''}
                onClick={() => void submitPrompt()}
              >
                {submitting ? 'Starting…' : 'Plan work…'}
              </Button>
            </div>
          </>
        )}

        {stage === 'running' && (
          <>
            <p className="plan-modal-status">
              Planning… the agent is reading the codebase and drafting an epic
              and its tasks. This can take a minute.
            </p>
            <div className="plan-modal-actions">
              <Button variant="secondary" onClick={onCancel}>
                Dismiss
              </Button>
            </div>
          </>
        )}

        {stage === 'failed' && (
          <>
            <p className="plan-modal-error">
              Planning failed{error ? `: ${error}` : '.'}
            </p>
            <div className="plan-modal-actions">
              <Button variant="secondary" onClick={onCancel}>
                Dismiss
              </Button>
            </div>
          </>
        )}

        {stage === 'ready' && draft !== null && (
          <>
            {confirmError !== null && (
              <div className="plan-modal-error">{confirmError}</div>
            )}

            {draft.epic !== undefined && (
              <div className="plan-modal-epic">
                <TextInput
                  className="plan-modal-epic-title"
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
                  className="plan-modal-epic-description"
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

            {draft.tasks.length === 0 ? (
              <p className="plan-modal-status">
                No tasks left in this plan — remove doesn&rsquo;t undo, so
                cancel and start a new plan if this isn&rsquo;t what you meant.
              </p>
            ) : (
              <div className="plan-modal-task-list">
                {draft.tasks.map((task, i) => (
                  <TaskEditRow
                    key={i}
                    task={task}
                    index={i}
                    allTasks={draft.tasks}
                    onEdit={editTask}
                    onRemove={removeTask}
                  />
                ))}
              </div>
            )}

            <div className="plan-modal-actions">
              <Button
                variant="secondary"
                onClick={onCancel}
                disabled={confirming}
              >
                Cancel
              </Button>
              <Button
                disabled={confirming || draft.tasks.length === 0}
                onClick={() => void submitConfirm()}
              >
                {confirming ? 'Creating…' : 'Confirm'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
