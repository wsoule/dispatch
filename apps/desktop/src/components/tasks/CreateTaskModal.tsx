import type { CreateInput, Priority, TaskDoc, TaskKind } from '@dispatch/core';
import { useState } from 'react';

import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';
import './CreateTaskModal.css';

// Fixed, non-config-driven enums — see TaskDetailModal.tsx for why these
// mirror core/types.ts's constants instead of importing them at runtime.
const KINDS: TaskKind[] = ['task', 'epic'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

interface CreateTaskModalProps {
  statuses: string[];
  epics: TaskDoc[];
  onCreate: (input: CreateInput) => Promise<void>;
  onClose: () => void;
}

/** Modal for creating a task. Title is the only required field; everything else has a sane
 * default so a quick "just capture this" flow stays one field deep. Mirrors
 * packages/web/src/components/CreateTask.tsx's fields, restyled native to Relay's Modal/tokens
 * rather than web's own modal markup. */
export function CreateTaskModal({
  statuses,
  epics,
  onCreate,
  onClose,
}: CreateTaskModalProps) {
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
    <Modal isOpen onClose={onClose} title="New Task">
      <div className="create-task-modal">
        {error !== null && (
          <div className="create-task-modal-error">{error}</div>
        )}

        <label className="create-task-modal-field">
          <span className="create-task-modal-field-label">Title</span>
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>

        <div className="create-task-modal-row">
          <label className="create-task-modal-field">
            <span className="create-task-modal-field-label">Kind</span>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </label>
          <label className="create-task-modal-field">
            <span className="create-task-modal-field-label">Priority</span>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="create-task-modal-row">
          <label className="create-task-modal-field">
            <span className="create-task-modal-field-label">Status</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <label className="create-task-modal-field">
            <span className="create-task-modal-field-label">Epic</span>
            <Select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">None</option>
              {epics.map((epic) => (
                <option key={epic.meta.id} value={epic.meta.id}>
                  {epic.meta.title}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <label className="create-task-modal-field">
          <span className="create-task-modal-field-label">Description</span>
          <textarea
            className="create-task-modal-description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="create-task-modal-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={() => void submit()}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
