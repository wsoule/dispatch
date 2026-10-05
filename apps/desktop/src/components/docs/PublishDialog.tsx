import type { ApiClient, DocPublishResult } from '@dispatch/client';
import { useId, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
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

interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: Pick<ApiClient, 'publishDoc'>;
  /** The doc's id or handle. */
  docRef: string;
  /** Where the path field starts: the last path asked for, else the published one. */
  initialPath: string;
  /** Called once the daemon created the publish task. */
  onPublished: (result: DocPublishResult, path: string) => void;
}

/** Asks for the repo path a doc publishes to, then creates and dispatches its elevated task. */
export function PublishDialog({
  open,
  onOpenChange,
  client,
  docRef,
  initialPath,
  onPublished,
}: PublishDialogProps) {
  const pathId = useId();
  const [path, setPath] = useState(initialPath);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setSending(true);
    setError(null);
    try {
      const result = await client.publishDoc(docRef, { path: path.trim() });
      onPublished(result, path.trim());
      onOpenChange(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to repo</DialogTitle>
          <DialogDescription>
            A run writes this revision to the path and commits it; a human
            merges it.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor={pathId} className="text-xs">
          Path in the repo
        </label>
        <Input
          id={pathId}
          value={path}
          placeholder="docs/specs/name.md"
          onChange={(e) => setPath(e.target.value)}
        />
        {error !== null && (
          <p role="alert" className="text-xs text-[var(--color-destructive)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={sending || path.trim() === ''}
            onClick={() => void publish()}
          >
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
