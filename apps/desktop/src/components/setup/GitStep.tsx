import { Button, cx, Field, TextField } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { gitSetupStatus, installGit, setGitIdentity } from '../../lib/tauri';
import styles from './setup.module.css';
import { SetupStepRow } from './SetupStepRow';

/** Git installed and named. Re-checks when the window regains focus (Apple's installer runs outside the app). */
export function GitStep({ onReady }: { onReady: (ready: boolean) => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['setup', 'git'],
    queryFn: gitSetupStatus,
    refetchOnWindowFocus: true,
  });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ready =
    data?.installed === true && data.name !== null && data.email !== null;
  useEffect(() => onReady(ready), [ready, onReady]);

  async function install() {
    setError(null);
    try {
      await installGit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (data === undefined)
    return <SetupStepRow status="checking" title="Git" message="Checking…" />;

  if (!data.installed) {
    return (
      <SetupStepRow
        status="missing"
        title="Git"
        message={
          data.installHint === null
            ? "Git isn't installed yet. Dispatch uses it to keep each agent's work separate. Apple's installer opens in its own window."
            : `Git isn't installed yet. Run this in a terminal, then come back: ${data.installHint}`
        }
        action={
          data.installHint === null ? (
            <Button variant="primary" onClick={() => void install()}>
              Install Git
            </Button>
          ) : undefined
        }
        {...(error === null ? {} : { detail: error })}
      />
    );
  }

  if (!ready) {
    async function save() {
      setError(null);
      try {
        await setGitIdentity(name, email);
        await queryClient.invalidateQueries({ queryKey: ['setup', 'git'] });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    return (
      <SetupStepRow
        status="needs-action"
        title="Git"
        message="Git labels every saved change with a name and email. These stay on your computer."
        {...(error === null ? {} : { detail: error })}
      >
        <div className={styles.identity}>
          <Field
            label="Your name"
            id="git-name"
            className={styles.identityField}
          >
            <TextField
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Your email"
            id="git-email"
            className={styles.identityField}
          >
            <TextField
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={name.trim() === '' || !email.includes('@')}
          >
            Save
          </Button>
        </div>
        {error !== null && (
          <p
            className={cx(styles.alert, 'toneText')}
            data-tone="danger"
            role="alert"
          >
            Couldn't save that. Check your name and email and try again.
          </p>
        )}
      </SetupStepRow>
    );
  }

  return (
    <SetupStepRow
      status="ok"
      title="Git"
      message="Git is installed and knows who you are."
    />
  );
}
