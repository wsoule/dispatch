import type { RunMeta } from '@dispatch/client';

import {
  mergeLadderLabel,
  mergeLadderPillLabel,
  mergeLadderState,
  mergeLadderTint,
} from '@/lib/mergeLadder';
import { LabelPill } from '@/ui/ai/pill';

interface MergeLadderPillProps {
  meta: RunMeta | undefined;
  /** Render the `Not merged` rung too. Off by default: a run that has not merged is the
   * common case, and Linear says nothing where nothing has happened. */
  showUnmerged?: boolean;
  className?: string;
}

/** Where a task's latest run sits on the merge ladder, as a `LabelPill` whose 8px dot takes
 * the rung's `--state-*` colour — amber once squashed into the base branch locally, the
 * landing teal once the merge commit has reached origin. The full state (branch, sha, PR)
 * is the pill's `title`. */
export function MergeLadderPill({
  meta,
  showUnmerged = false,
  className,
}: MergeLadderPillProps) {
  const state = mergeLadderState(meta);
  if (state === 'unmerged' && !showUnmerged) return null;
  return (
    <LabelPill
      color={mergeLadderTint(state)}
      data-merge-ladder={state}
      title={mergeLadderLabel(meta)}
      className={className}
    >
      {mergeLadderPillLabel(state)}
    </LabelPill>
  );
}
