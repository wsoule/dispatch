import type { DispatchConfig } from '@dispatch-foo/core/browser';
import type { StartTeamInput } from '@dispatch/client';
import { Button, RadioGroup, TextField } from '@dispatch/ui';
import { useState } from 'react';

import { SettingsRow } from './SettingsGroup';
import styles from './StartTeamRow.module.css';

type Choice = 'repo' | 'project';

const CHOICES: { value: Choice; label: string }[] = [
  { value: 'repo', label: 'A separate board repo (recommended)' },
  { value: 'project', label: 'This project’s repo (branch dispatch-sync)' },
];

/** Where config.yml already keeps the board, in words, or null when nobody
 *  chose a place yet. */
function chosenPlace(sync: DispatchConfig['sync']): string | null {
  if (sync?.repo !== undefined) return sync.repo;
  if (sync?.remote !== undefined)
    return `this project's "${sync.remote}" remote`;
  return null;
}

/** What starting sends for a choice: the place it names, beside the relay
 *  confirmation; null while a separate repo has no URL yet. */
function startInput(
  choice: Choice,
  url: string,
  placed: boolean
): StartTeamInput | null {
  if (placed) return { confirmed: true };
  if (choice === 'project') return { confirmed: true, remote: 'origin' };
  const repo = url.trim();
  return repo === '' ? null : { confirmed: true, repo };
}

/**
 * Settings → Team, "Start a team": the relay disclosure, and where the team's
 * board is kept, since sync never pushes to a place nobody chose. A place
 * config.yml already names is shown and used as it is.
 */
export function StartTeamRow({
  sync,
  disclosure,
  busy,
  onStart,
}: {
  sync: DispatchConfig['sync'];
  disclosure: string;
  busy: boolean;
  onStart: (input: StartTeamInput) => void;
}) {
  const [choice, setChoice] = useState<Choice>('repo');
  const [url, setUrl] = useState('');
  const placed = chosenPlace(sync);
  const input = startInput(choice, url, placed !== null);
  const branch = sync?.branch ?? 'dispatch-sync';

  return (
    <SettingsRow
      title="Start a team"
      subtitle={disclosure}
      stacked
      control={
        <Button
          size="sm"
          data-testid="team-start"
          disabled={busy || input === null}
          onClick={() => {
            if (input !== null) onStart(input);
          }}
        >
          Start a team
        </Button>
      }
    >
      {placed !== null ? (
        <span data-testid="team-start-place" className={styles.place}>
          The team&rsquo;s board is kept at {placed}, on branch {branch}.
        </span>
      ) : (
        <div className={styles.choose}>
          <RadioGroup
            label="Where the team's board is kept"
            orientation="horizontal"
            value={choice}
            options={CHOICES}
            onChange={(next) =>
              setChoice(next === 'project' ? 'project' : 'repo')
            }
          />
          {choice === 'repo' && (
            <TextField
              size="sm"
              aria-label="Board repo URL"
              placeholder="git@github.com:acme/dispatch-board.git"
              className={styles.url}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </div>
      )}
    </SettingsRow>
  );
}
