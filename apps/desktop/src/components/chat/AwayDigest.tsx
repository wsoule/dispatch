import { useCallback, useState } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import type { NarratorLine } from '../../lib/narrator';
import { doorLabel, type OverseerDoor } from '../../lib/overseerThread';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

const SEEN_PREFIX = 'dispatch:narrator-seen:';

function readSeen(projectPath: string): string | null {
  try {
    return window.localStorage.getItem(SEEN_PREFIX + projectPath);
  } catch {
    return null;
  }
}

function writeSeen(projectPath: string, at: string): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + projectPath, at);
  } catch {
    // Blocked storage: the digest still clears for this session.
  }
}

/**
 * When this project's digest was last dismissed. A project never seen starts
 * now, so the first open says nothing rather than replaying all of history.
 */
export function useNarratorSince(projectPath: string | null): {
  since: string;
  dismiss: () => void;
} {
  const key = projectPath ?? '';
  const [state, setState] = useState(() => ({ key, since: initial(key) }));
  // A project switch re-reads that project's own mark.
  const current = state.key === key ? state : { key, since: initial(key) };
  if (current !== state) setState(current);
  const dismiss = useCallback(() => {
    const now = new Date().toISOString();
    writeSeen(key, now);
    setState({ key, since: now });
  }, [key]);
  return { since: current.since, dismiss };
}

function initial(key: string): string {
  const now = new Date().toISOString();
  // No project (or Classic): nothing to remember.
  if (key === '') return now;
  const seen = readSeen(key);
  if (seen !== null) return seen;
  writeSeen(key, now);
  return now;
}

// The same colours as the top bar's counts.
const TONE: Record<NarratorLine['tone'], string> = {
  failed: 'text-(--state-failed-fg)',
  review: 'text-(--state-review-fg)',
  landed: 'text-muted-foreground',
};

/** The narrator's "While you were away", above the composer; dismissing marks it seen. */
export function AwayDigest({
  lines,
  since,
  onDismiss,
  onOpenDoor,
}: {
  lines: NarratorLine[];
  since: string;
  onDismiss: () => void;
  onOpenDoor: (door: OverseerDoor) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <section
      aria-label="While you were away"
      data-testid="away-digest"
      className="rounded-card border-border flex flex-col gap-1 border-[0.5px] px-3 py-2"
    >
      <div className="text-muted-foreground font-book flex items-center gap-2 text-[11px]">
        <span className="flex-1">
          While you were away · since {formatRelativeTimeFromIso(since)}
        </span>
        <Button variant="ghost" size="xs" onClick={onDismiss}>
          Got it
        </Button>
      </div>
      {lines.map((line) => (
        <div
          key={line.key}
          className="font-book flex items-center gap-2 text-[13px]"
        >
          <span className={cn('min-w-0 flex-1 truncate', TONE[line.tone])}>
            {line.text}
          </span>
          <button
            type="button"
            onClick={() => onOpenDoor(line.door)}
            className="text-muted-foreground hover:text-foreground shrink-0 text-[12px] hover:underline"
          >
            {doorLabel(line.door)}
          </button>
        </div>
      ))}
    </section>
  );
}
