import type { ApiClient } from '@dispatch/client';
import { cx } from '@dispatch/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTerminalOutput } from '../../hooks/useTerminalOutput';
import { createInputQueue } from '../../lib/terminalInput';
import { encodeKey } from '../../lib/terminalKeys';
import { RawDetails } from '../gr8r/RawText';
import { TerminalCanvas } from '../terminal/TerminalCanvas';
import { errorText } from './errorText';
import styles from './setup.module.css';

interface CommandTerminalProps {
  client: ApiClient;
  command: string[];
  title: string;
  /** Fires once when the command exits, with its exit code (null if unknown). */
  onExit: (exitCode: number | null) => void;
}

/** A small inline terminal running one command (an installer or a sign-in), keyboard included. */
export function CommandTerminal({
  client,
  command,
  title,
  onExit,
}: CommandTerminalProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const exited = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Started once per mount from the first props; a new command remounts via `key`.
  const launch = useRef({ command, title });
  const { screen, revision, info, refresh } = useTerminalOutput(
    client,
    terminalId,
    null
  );

  // Set once the command is started. An effect runs again when a hidden Activity shows
  // this terminal again (Settings closing over a setup gate) and twice under StrictMode,
  // while refs and state survive both, so the command runs once per mount. The result is
  // kept even if it lands while the terminal is hidden.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    client
      .createTerminal(launch.current)
      .then((t) => setTerminalId(t.id))
      .catch((err: unknown) => setStartError(errorText(err)));
  }, [client]);

  useEffect(() => {
    if (info !== null && info.state !== 'running' && !exited.current) {
      exited.current = true;
      onExit(info.exitCode ?? null);
    }
  }, [info, onExit]);

  // Takes focus when it first shows, so the keys reach the command; not again when a
  // hidden Activity shows it once more, where focus goes back to what had it.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    focused.current = true;
    surfaceRef.current?.focus();
  }, []);

  const send = useMemo(
    () =>
      createInputQueue(async (data) => {
        if (terminalId === null) return;
        await client.sendTerminalInput(terminalId, data);
        refresh();
      }),
    [client, terminalId, refresh]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const bytes = encodeKey(event);
      if (bytes === null) return;
      event.preventDefault();
      send(bytes);
    },
    [send]
  );

  if (startError !== null) {
    return (
      <div className={styles.problem}>
        <p
          className={cx(styles.alert, 'toneText')}
          data-tone="danger"
          role="alert"
        >
          Couldn&apos;t start that. Try again.
        </p>
        <RawDetails text={startError} />
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={styles.terminal}
      aria-label={title}
    >
      <TerminalCanvas screen={screen} revision={revision} search="" follow />
    </div>
  );
}
