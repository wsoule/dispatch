import type { ApiClient, TerminalInfo } from '@dispatch/client';
import { Button, Select, TextField } from '@dispatch/ui';
import { Columns2, Plus, Rows2, Search, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TerminalSubscribe } from '../../hooks/useTerminalOutput';
import { useTerminalOutput } from '../../hooks/useTerminalOutput';
import { createInputQueue } from '../../lib/terminalInput';
import { encodeKey } from '../../lib/terminalKeys';
import { TerminalCanvas } from './TerminalCanvas';
import styles from './TerminalPane.module.css';

const ICON = { size: 14, strokeWidth: 1.8 } as const;

/**
 * One pane of the terminal view: a session's screen, its keyboard, and the
 * controls that act on the pane itself.
 *
 * Keystrokes are encoded to the bytes a pty expects (see lib/terminalKeys) and
 * posted; the screen updates when the daemon reports the output, not
 * optimistically. That round trip is what makes local echo correct — the shell
 * decides what a keystroke looks like, including when it shows nothing at all,
 * as at a password prompt.
 */

interface TerminalPaneProps {
  client: ApiClient | null;
  paneId: string;
  terminalId: string | null;
  terminals: TerminalInfo[];
  focused: boolean;
  subscribe: TerminalSubscribe | null;
  onFocus: () => void;
  onAttach: (terminalId: string | null) => void;
  onOpenSession: () => void;
  onSplit: (direction: 'row' | 'column') => void;
  onClose: () => void;
  onRemoveSession: (terminalId: string) => void;
}

function stateLabel(info: TerminalInfo | null): string {
  if (info === null) return '';
  if (info.state === 'running')
    return info.pty ? 'running' : 'running (no pty)';
  if (info.state === 'orphaned') return 'from a previous daemon — read only';
  return info.exitCode === null ? 'exited' : `exited ${info.exitCode}`;
}

export function TerminalPane({
  client,
  paneId,
  terminalId,
  terminals,
  focused,
  subscribe,
  onFocus,
  onAttach,
  onOpenSession,
  onSplit,
  onClose,
  onRemoveSession,
}: TerminalPaneProps) {
  const { screen, revision, info, refresh } = useTerminalOutput(
    client,
    terminalId,
    subscribe
  );
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  // Scroll following is off while searching: jumping to the bottom on every
  // chunk is exactly wrong when the user is reading something further up.
  const [follow, setFollow] = useState(true);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const running = info?.state === 'running';

  // Queued so keys typed faster than a round trip still arrive in order.
  const send = useMemo(
    () =>
      createInputQueue(async (data) => {
        if (client === null || terminalId === null) return;
        await client.sendTerminalInput(terminalId, data);
        // Read straight back rather than waiting for the socket: at a prompt
        // the echo is the only feedback that a key landed.
        refresh();
      }),
    [client, terminalId, refresh]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!running) return;
      const bytes = encodeKey(event);
      if (bytes === null) return;
      event.preventDefault();
      event.stopPropagation();
      send(bytes);
    },
    [running, send]
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!running) return;
      const text = event.clipboardData.getData('text');
      if (text === '') return;
      event.preventDefault();
      send(text);
    },
    [running, send]
  );

  useEffect(() => {
    if (focused) surfaceRef.current?.focus();
  }, [focused]);

  // Focused on open rather than through `autoFocus`: the attribute is a
  // genuine accessibility problem when a page loads with it, and this field
  // only exists because the user just asked for it.
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  // A pane-level button: icon only, named by the same words as its hover title.
  const paneButton = (label: string, icon: ReactNode, onClick: () => void) => (
    <Button
      variant="quiet"
      size="sm"
      icon={icon}
      aria-label={label}
      title={label}
      onClick={onClick}
    />
  );

  return (
    <div
      className={styles.pane}
      data-focused={focused ? '' : undefined}
      onMouseDown={onFocus}
      data-testid={`terminal-pane-${paneId}`}
    >
      <div className={styles.toolbar}>
        <Select
          label="Session shown in this pane"
          className={styles.session}
          value={terminalId ?? ''}
          options={[
            { value: '', label: 'No session' },
            ...terminals.map((terminal) => ({
              value: terminal.id,
              label:
                terminal.state === 'running'
                  ? terminal.title
                  : `${terminal.title} · ${terminal.state}`,
            })),
          ]}
          onChange={(value) => onAttach(value === '' ? null : value)}
        />
        <span className={styles.state}>{stateLabel(info)}</span>
        {paneButton('New session', <Plus {...ICON} />, onOpenSession)}
        {paneButton('Search scrollback', <Search {...ICON} />, () => {
          setSearching((value) => !value);
          setFollow(searching);
        })}
        {paneButton('Split right', <Columns2 {...ICON} />, () =>
          onSplit('row')
        )}
        {paneButton('Split down', <Rows2 {...ICON} />, () => onSplit('column'))}
        {terminalId !== null &&
          paneButton('End and forget this session', <Trash2 {...ICON} />, () =>
            onRemoveSession(terminalId)
          )}
        {paneButton('Close pane', <X {...ICON} />, onClose)}
      </div>

      {searching && (
        <div className={styles.search}>
          <TextField
            ref={searchRef}
            size="sm"
            value={search}
            placeholder="Find in scrollback"
            aria-label="Find in scrollback"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      )}

      {/* The keyboard surface. `tabIndex` makes a div focusable, which is what
          lets a pane take keystrokes without an input element stealing and
          reinterpreting them. */}
      <div
        ref={surfaceRef}
        tabIndex={0}
        role="textbox"
        aria-label="Terminal"
        className={styles.surface}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onFocus}
      >
        {terminalId === null ? (
          <div className={styles.empty}>
            <span>No session in this pane.</span>
            <Button size="sm" variant="secondary" onClick={onOpenSession}>
              Open a shell
            </Button>
          </div>
        ) : (
          <TerminalCanvas
            screen={screen}
            revision={revision}
            search={searching ? search : ''}
            follow={follow && !searching}
          />
        )}
      </div>
    </div>
  );
}
