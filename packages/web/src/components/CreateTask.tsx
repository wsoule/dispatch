import type { CreateInput, Priority, TaskDoc, TaskKind } from '@dispatch/core';
import { useState } from 'react';

// Fixed, non-config-driven enums — see TaskDetail.tsx for why these mirror
// core/types.ts's constants instead of importing them.
const KINDS: TaskKind[] = ['task', 'epic'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export interface CreateTaskProps {
  statuses: string[];
  epics: TaskDoc[];
  onCreate: (input: CreateInput) => Promise<void>;
  onClose: () => void;
}

// Centered modal for creating a task. Title is the only required field;
// everything else has a sane default so a quick "just capture this" flow
// stays one field deep.
export function CreateTask({
  statuses,
  epics,
  onCreate,
  onClose,
}: CreateTaskProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TaskKind>('task');
  const [priority, setPriority] = useState<Priority>('none');
  const [status, setStatus] = useState(statuses[0] ?? 'backlog');
  const [parent, setParent] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (title.trim() === '') {
      setError('title is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        kind,
        priority,
        status,
        parent: parent !== '' ? parent : null,
        description,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Create task"
      >
        <div className="modal__header">
          <span className="modal__title">New Task</span>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {error !== null && <div className="modal__error">{error}</div>}

        <div className="field">
          <label className="field__label" htmlFor="create-title">
            Title
          </label>
          <input
            id="create-title"
            className="control"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className="modal__row">
          <div className="field">
            <label className="field__label" htmlFor="create-kind">
              Kind
            </label>
            <select
              id="create-kind"
              className="control"
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="create-priority">
              Priority
            </label>
            <select
              id="create-priority"
              className="control"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="modal__row">
          <div className="field">
            <label className="field__label" htmlFor="create-status">
              Status
            </label>
            <select
              id="create-status"
              className="control"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="create-parent">
              Epic
            </label>
            <select
              id="create-parent"
              className="control"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">None</option>
              {epics.map((epic) => (
                <option key={epic.meta.id} value={epic.meta.id}>
                  {epic.meta.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="create-description">
            Description
          </label>
          <textarea
            id="create-description"
            className="control"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting}
            onClick={() => void submit()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
