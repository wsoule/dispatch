import type { RunMeta } from '@dispatch/client';

import { mergeLadderLabel, mergeLadderState } from '@/lib/mergeLadder';
import { cn } from '@/lib/utils';

const MERGE_LADDER_DOT: Record<ReturnType<typeof mergeLadderState>, string> = {
  unmerged: 'bg-muted-foreground/40',
  'merged-local': 'bg-amber-500/70',
  'on-origin': 'bg-emerald-500',
};

interface MergeLadderDotProps {
  meta: RunMeta | undefined;
  className?: string;
}

/** Small dot marking a task's latest run on the merge ladder — unmerged (hollow-ish, muted),
 * merged-local (amber, squashed into the base branch but not yet on origin), or on-origin
 * (emerald, the merge commit has reached origin). Mirrors RunStatePill's structure: one shared
 * state -> color mapping, rendered as a bare dot with the full state as its `title`. */
export function MergeLadderDot({ meta, className }: MergeLadderDotProps) {
  const state = mergeLadderState(meta);
  return (
    <span
      title={mergeLadderLabel(
        state,
        meta?.branch,
        meta?.mergeCommit,
        meta?.prUrl
      )}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        MERGE_LADDER_DOT[state],
        className
      )}
    />
  );
}
