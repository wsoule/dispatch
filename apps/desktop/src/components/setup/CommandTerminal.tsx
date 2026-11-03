import type { ApiClient } from '@dispatch/client';
import { cx } from '@dispatch/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTerminalOutput } from '../../hooks/useTerminalOutput';
import { createInputQueue } from '../../lib/terminalInput';
import { encodeKey } from '../../lib/terminalKeys';
import { whenDisconnected } from '../../lib/whenDisconnected';
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
  /** End the command when the terminal unmounts for good. For a sign-in,
   *  which otherwise waits in a PTY nobody can see; an installer leaves it
   *  off, since stopping `npm install -g` or `brew` midway can leave a
   *  half-installed package, and it finishes on its own. */
  endOnUnmount?: boolean;
}

/**
 * A small inline terminal running one command (an installer or a sign-in), keyboard
 * included. Its surface is a `textbox` named by `title`, as the Terminals view's
 * pane is. Tab and Shift+Tab are not sent to the command: it is one installer or
 * sign-in, not a shell, so they move focus on (to Continue, say) as anywhere else.
 * With `endOnUnmount`, unmounting it for good (Continue while a sign-in still runs)
 * ends the command through `client.closeTerminal`, so no login is left waiting in a
 * PTY nobody can see; hiding it (a hidden Activity) keeps the command running, and
 * a terminal removed while hidden ends it then.
 */
export function CommandTerminal({
  client,
  command,
  title,
  onExit,
  endOnUnmount = false,
}: CommandTerminalProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const exited = useRef(false);
  // The started command's terminal, for the unmount below, and whether this
  // terminal is unmounted for good (a start that lands later ends at once).
  const terminalRef = useRef<string | null>(null);
  const gone = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Started once per mount from the first props; a new command remounts via `key`.
  const launch = useRef({ command, title });
  const end = useRef(endOnUnmount);
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
      .then((t) => {
        if (gone.current) {
          if (end.current) endCommand(client, t.id);
          return;
        }
        terminalRef.current = t.id;
        setTerminalId(t.id);
      })
      .catch((err: unknown) => {
        if (!gone.current) setStartError(errorText(err));
      });
  }, [client]);

  // Ends a still-running command when the terminal unmounts for good. A hidden
  // Activity and StrictMode's rehearsal run this cleanup too, but they leave the
  // surface in the document; only a real unmount has taken it out by the time
  // passive cleanups run. A hidden terminal gets no cleanup if it is removed
  // later (the setup gate clearing while Settings covers it), so a hide watches
  // for the surface leaving the document until the terminal shows again.
  const stopWatch = useRef<(() => void) | null>(null);
  useEffect(() => {
    stopWatch.current?.();
    stopWatch.current = null;
    const surface = surfaceRef.current;
    const finish = () => {
      gone.current = true;
      const id = terminalRef.current;
      if (end.current && id !== null && !exited.current) endCommand(client, id);
    };
    return () => {
      if (surface === null) return;
      if (surface.isConnected)
        stopWatch.current = whenDisconnected(surface, finish);
      else finish();
    };
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
      // Tab and Shift+Tab move focus out, so the keyboard is never trapped
      // in a command that may wait a long time (WCAG 2.1.2).
      if (
        event.key === 'Tab' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        return;
      }
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
      role="textbox"
      onKeyDown={onKeyDown}
      className={styles.terminal}
      aria-label={title}
    >
      <TerminalCanvas screen={screen} revision={revision} search="" follow />
    </div>
  );
}

// Ends a command's process (keeping its scrollback, as an exit does). Fire and
// forget: the terminal is gone, so a refusal (the command ended meanwhile, the
// daemon went away) has no one to tell.
function endCommand(client: ApiClient, terminalId: string) {
  client.closeTerminal(terminalId).catch(() => {});
}
