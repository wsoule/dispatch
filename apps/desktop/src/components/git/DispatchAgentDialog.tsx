import type { ApiClient } from '@dispatch/client';
import { useEffect, useState } from 'react';

import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

interface DispatchAgentDialogProps {
  open: boolean;
  onClose: () => void;
  defaultTitle: string;
  defaultPrompt: string;
  client: ApiClient | null;
  onDispatch: (taskId: string) => Promise<void>;
}

/** "Dispatch an agent here" — seeds a task from the prompt and runs it through the same
 * create-task-then-dispatch path the rest of the app uses, always as a fresh run/worktree. */
export function DispatchAgentDialog({
  open,
  onClose,
  defaultTitle,
  defaultPrompt,
  client,
  onDispatch,
}: DispatchAgentDialogProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setPrompt(defaultPrompt);
      setError(null);
    }
  }, [open, defaultTitle, defaultPrompt]);

  async function submit() {
    if (client === null || title.trim() === '') return;
    setSubmitting(true);
    setError(null);
    try {
      const task = await client.createTask({
        title: title.trim(),
        kind: 'task',
        priority: 'high',
        description: prompt.trim(),
      });
      await onDispatch(task.meta.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispatch an agent</DialogTitle>
          <DialogDescription>
            Creates a task from this prompt and starts a run on it, the same way
            dispatching from the board does.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
          />
          <Textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
          />
          {error !== null && (
            <p className="text-destructive text-[12px]">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || title.trim() === ''}
          >
            Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
