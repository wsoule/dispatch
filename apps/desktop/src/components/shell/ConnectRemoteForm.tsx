import { parsePairingLink, remoteUrlProblem } from '@dispatch/client';
import { Button, Field, Notice, Spinner, TextField } from '@dispatch/ui';
import { useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { pairRemote } from '../../lib/remoteConnections';
import styles from './ConnectRemoteForm.module.css';

interface ConnectRemoteFormProps {
  /** Called with the remote's root once paired and saved. */
  onConnected: (root: string) => void;
  /** Injectable for tests; defaults to the real pairing call. */
  pair?: typeof pairRemote;
}

// What the daemon lists this app as under `dispatch pair list`.
function defaultDeviceName(): string {
  const platform =
    typeof navigator === 'undefined' ? '' : (navigator.platform ?? '');
  return platform === '' ? 'Dispatch app' : `Dispatch app (${platform})`;
}

/**
 * Pairs this app with a dispatchd on another machine: its URL and the
 * one-time code `dispatch pair` printed there, or the `dispatch://pair` link
 * it printed, pasted whole into the URL field. The transport rule (https, or
 * http to loopback for an SSH forward) is checked as the URL is typed, so the
 * reason shows before anything is sent.
 */
export function ConnectRemoteForm({
  onConnected,
  pair = pairRemote,
}: ConnectRemoteFormProps) {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A pasted link fills both fields.
  const link = parsePairingLink(url);
  const effectiveUrl = link?.baseUrl ?? url;
  const effectiveCode = link?.code ?? code;
  const urlProblem =
    effectiveUrl.trim() === '' ? null : remoteUrlProblem(effectiveUrl);
  const ready =
    effectiveUrl.trim() !== '' &&
    urlProblem === null &&
    effectiveCode.trim() !== '' &&
    !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onConnected(
        await pair({
          url: effectiveUrl,
          code: effectiveCode,
          deviceName: defaultDeviceName(),
        })
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <Field
        label="Daemon URL or pairing link"
        id="remote-url"
        hint="Run `dispatch pair` on the machine the daemon runs on. Over SSH, forward its port and use http://127.0.0.1:<port>."
        error={urlProblem ?? undefined}
      >
        <TextField
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://devbox.example.com:4771"
          spellCheck={false}
        />
      </Field>
      {link === null && (
        <Field label="Pairing code" id="remote-code">
          <TextField
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      {error !== null && (
        <Notice tone="danger" role="alert">
          <span className={styles.error}>{error}</span>
        </Notice>
      )}
      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          disabled={!ready}
          icon={busy ? <Spinner label="" /> : undefined}
        >
          Connect
        </Button>
      </div>
    </form>
  );
}
