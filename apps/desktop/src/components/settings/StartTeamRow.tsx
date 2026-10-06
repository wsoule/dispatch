import type { DispatchConfig } from '@dispatch-foo/core/browser';
import type { StartTeamInput } from '@dispatch/client';
import { useState } from 'react';

import { SettingsRow } from './SettingsGroup';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

type Choice = 'repo' | 'project';

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
          variant="outline"
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
        <span
          data-testid="team-start-place"
          className="text-muted-foreground text-[12px]"
        >
          The team&rsquo;s board is kept at {placed}, on branch {branch}.
        </span>
      ) : (
        <div className="flex flex-col gap-2">
          <div
            role="radiogroup"
            aria-label="Where the team's board is kept"
            className="flex flex-wrap gap-2"
          >
            <Button
              size="sm"
              role="radio"
              aria-checked={choice === 'repo'}
              variant={choice === 'repo' ? 'secondary' : 'ghost'}
              onClick={() => setChoice('repo')}
            >
              A separate board repo (recommended)
            </Button>
            <Button
              size="sm"
              role="radio"
              aria-checked={choice === 'project'}
              variant={choice === 'project' ? 'secondary' : 'ghost'}
              onClick={() => setChoice('project')}
            >
              This project&rsquo;s repo (branch dispatch-sync)
            </Button>
          </div>
          {choice === 'repo' && (
            <Input
              aria-label="Board repo URL"
              placeholder="git@github.com:acme/dispatch-board.git"
              className="h-7 w-80 font-mono text-[12px]"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </div>
      )}
    </SettingsRow>
  );
}
