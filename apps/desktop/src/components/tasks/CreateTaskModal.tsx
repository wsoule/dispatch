import type { CreateInput, Priority, TaskDoc, TaskKind } from '@dispatch/core';
import { useState } from 'react';

import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select';
import { Textarea } from '../../ui/textarea';

// Fixed, non-config-driven enums — see TaskDetailModal.tsx for why these
// mirror core/types.ts's constants instead of importing them at runtime.
const KINDS: TaskKind[] = ['task', 'epic'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

// Radix `SelectItem` can't take an empty-string `value` (it's reserved to mean "no
// selection" internally) — this stands in for the "None" epic option, and is translated
// back to `''`/`null` at the state and submit boundaries so the rest of the component still
// only ever deals with the plain empty string it always has.
const NO_EPIC = '__none__';

interface CreateTaskModalProps {
  statuses: string[];
  epics: TaskDoc[];
  onCreate: (input: CreateInput) => Promise<void>;
  onClose: () => void;
}

/** Modal for creating a task. Title is the only required field; everything else has a sane
 * default so a quick "just capture this" flow stays one field deep. Mirrors
 * packages/web/src/components/CreateTask.tsx's fields, built on shadcn's `Dialog` — a true
 * modal that blocks the rest of the app, unlike the peek panel's overlay. */
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {error !== null && (
            <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-[13px]">
              {error}
            </div>
          )}

          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-muted-foreground text-[13px]">Title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-muted-foreground text-[13px]">Kind</span>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as TaskKind)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-muted-foreground text-[13px]">
                Priority
              </span>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as Priority)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-muted-foreground text-[13px]">Status</span>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-muted-foreground text-[13px]">Epic</span>
              <Select
                value={parent === '' ? NO_EPIC : parent}
                onValueChange={(value) =>
                  setParent(value === NO_EPIC ? '' : value)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EPIC}>None</SelectItem>
                  {epics.map((epic) => (
                    <SelectItem key={epic.meta.id} value={epic.meta.id}>
                      {epic.meta.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[13px]">
              Description
            </span>
            <Textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={() => void submit()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
