import type { ApiClient, DocPublishResult } from '@dispatch/client';
import { Button, cx, Dialog, Field, TextField } from '@dispatch/ui';
import { useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import styles from './PublishDialog.module.css';

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

/** Asks for the repo path a doc publishes to, then creates and dispatches
 *  its elevated task. The path field takes focus on open; while the publish
 *  is in flight the dialog cannot be dismissed. */
export function PublishDialog({
  open,
  onOpenChange,
  client,
  docRef,
  initialPath,
  onPublished,
}: PublishDialogProps) {
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
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="Publish to repo"
      description="A run writes this revision to the path and commits it; a human merges it."
      dismissible={!sending}
      actions={
        <>
          <Button
            variant="quiet"
            disabled={sending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={sending || path.trim() === ''}
            onClick={() => void publish()}
          >
            Publish
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Field label="Path in the repo">
          <TextField
            className={styles.path}
            value={path}
            placeholder="docs/specs/name.md"
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        {error !== null && (
          <p
            role="alert"
            className={cx('toneText', styles.error)}
            data-tone="danger"
          >
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
