import type { ApiClient } from '@dispatch/client';
import { useId, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';

interface NewDocDialogProps {
  client: Pick<ApiClient, 'createDoc'>;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

/** A title and a Team/Personal choice: a team doc every teammate and run can
 *  read, or a personal one only its owner sees. */
export function NewDocDialog({
  client,
  open,
  onClose,
  onCreated,
}: NewDocDialogProps) {
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<'team' | 'personal'>('team');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const name = title.trim();
    setSending(true);
    setError(null);
    try {
      const result = await client.createDoc({
        title: name,
        body: `# ${name}\n`,
        scope,
      });
      setTitle('');
      setScope('team');
      onCreated(result.doc.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New doc</DialogTitle>
        </DialogHeader>
        <label htmlFor={titleId} className="text-xs">
          Title
        </label>
        <Input
          id={titleId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <fieldset className="flex gap-4 text-xs">
          <legend className="sr-only">Who sees it</legend>
          {(
            [
              ['team', 'Team'],
              ['personal', 'Personal'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1">
              <input
                type="radio"
                name="doc-scope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {error !== null && (
          <p role="alert" className="text-xs text-[var(--color-destructive)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={sending || title.trim() === ''}
            onClick={() => void create()}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
