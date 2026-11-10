import { Button } from '@dispatch/ui';
import { useState } from 'react';

import { type CliInstall, installCliCommand } from '../../lib/tauri';
import { errorText } from './errorText';
import { SetupStepRow } from './SetupStepRow';

// Only ~/.local/bin can be off PATH (/usr/local/bin always counts as on it).
const NOT_ON_PATH = `Installed. Add ~/.local/bin to your PATH to use it: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`;

/** Optional: puts the `dispatch` command on PATH for people who also use a terminal. */
export function CliCommandStep() {
  const [linked, setLinked] = useState<CliInstall | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function install() {
    setBusy(true);
    setDetail(null);
    try {
      setLinked(await installCliCommand());
    } catch (err) {
      setDetail(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupStepRow
      status={
        linked === null ? 'waiting' : linked.onPath ? 'ok' : 'needs-action'
      }
      title="Terminal command"
      message={
        linked !== null
          ? linked.onPath
            ? `Installed at ${linked.path}`
            : NOT_ON_PATH
          : detail !== null
            ? "Couldn't install the command."
            : 'Use Dispatch from a terminal with the `dispatch` command.'
      }
      action={
        // Optional, and drawn beside other steps' primary buttons (Settings > Setup):
        // secondary, so a view keeps one primary action.
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void install()}
        >
          Install command
        </Button>
      }
      {...(detail === null ? {} : { detail })}
    />
  );
}
