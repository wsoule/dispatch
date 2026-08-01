import type { GitLogEntry } from '@dispatch/client';

import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';

interface CommitsPanelProps {
  commits: GitLogEntry[];
  loading: boolean;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}

/** Panel 4: the commit log for whichever branch is selected in the Branches panel (or HEAD
 * when none is). Selecting a row shows that commit's diff in the right pane. */
export function CommitsPanel({
  commits,
  loading,
  selectedIndex,
  onSelectIndex,
}: CommitsPanelProps) {
  if (loading) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">Loading…</div>
    );
  }
  if (commits.length === 0) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">No commits.</div>
    );
  }

  return (
    <div className="flex flex-col">
      {commits.map((commit, index) => (
        <button
          key={commit.sha}
          type="button"
          onClick={() => onSelectIndex(index)}
          className={cn(
            'flex flex-col gap-0.5 px-3 py-1.5 text-left text-[12px]',
            index === selectedIndex ? 'bg-accent' : 'hover:bg-muted/50'
          )}
        >
          <span className="truncate">{commit.subject}</span>
          <span className="text-muted-foreground flex items-center gap-2 text-[10.5px]">
            <span className="font-mono">{commit.shortSha}</span>
            <span className="truncate">{commit.author}</span>
            <span>{formatRelativeTimeFromIso(commit.date)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
