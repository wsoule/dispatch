import type { ApiClient } from '@dispatch/client';
import { Button, cx, Dialog, Field, RadioGroup, TextField } from '@dispatch/ui';
import { useId, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import styles from './NewDocDialog.module.css';

interface NewDocDialogProps {
  client: Pick<ApiClient, 'createDoc'>;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

type Scope = 'team' | 'personal';

// Who a new doc is for: everyone on the team, or only you.
const SCOPES: readonly { value: Scope; label: string; hint: string }[] = [
  { value: 'team', label: 'Team', hint: 'Every teammate and their agents' },
  { value: 'personal', label: 'Personal', hint: 'Only you' },
];

/** A title and a Team/Personal choice: a team doc every teammate and run can
 *  read, or a personal one only its owner sees. The title field takes focus
 *  on open; while the create is in flight the dialog cannot be dismissed. */
export function NewDocDialog({
  client,
  open,
  onClose,
  onCreated,
}: NewDocDialogProps) {
  const scopeLabelId = useId();
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<Scope>('team');
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
    <Dialog
      open={open}
      onClose={onClose}
      title="New doc"
      dismissible={!sending}
      actions={
        <>
          <Button variant="quiet" disabled={sending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={sending}
            busyLabel="Creating…"
            disabled={title.trim() === ''}
            onClick={() => void create()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Field label="Title">
          <TextField
            value={title}
            placeholder="Checkout v2 spec"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className={styles.scope}>
          <span id={scopeLabelId} className={styles.scopeLabel}>
            Who sees it
          </span>
          <RadioGroup
            aria-labelledby={scopeLabelId}
            name="new-doc-scope"
            value={scope}
            onChange={(value) => {
              const picked = SCOPES.find((option) => option.value === value);
              if (picked !== undefined) setScope(picked.value);
            }}
            options={SCOPES}
          />
        </div>
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
