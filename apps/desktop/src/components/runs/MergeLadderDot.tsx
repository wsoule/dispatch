import type { RunMeta } from '@dispatch/client';
import { Chip } from '@dispatch/ui';

import {
  mergeLadderLabel,
  mergeLadderPillLabel,
  mergeLadderState,
  mergeLadderTone,
} from '@/lib/mergeLadder';

interface MergeLadderPillProps {
  meta: RunMeta | undefined;
  /** Render the `Not merged` rung too. Off by default: a run that has not merged is the
   * common case, and Linear says nothing where nothing has happened. */
  showUnmerged?: boolean;
}

/** Where a task's latest run sits on the merge ladder, as a library `Chip` toned by
 * `mergeLadderTone` (the status pill: neutral and bordered, the hue in its dot): amber once
 * squashed into the base branch locally with a push still owed, green once the work is where
 * it is going, and a grey dot for the resting `Not merged` rung. The words always say the rung
 * too, so the hue is never the only cue. The full state (branch, sha, PR) is the chip's
 * `title`. */
export function MergeLadderPill({
  meta,
  showUnmerged = false,
}: MergeLadderPillProps) {
  const state = mergeLadderState(meta);
  if (state === 'unmerged' && !showUnmerged) return null;
  return (
    <Chip
      tone={mergeLadderTone(state)}
      dot
      data-merge-ladder={state}
      title={mergeLadderLabel(meta)}
    >
      {mergeLadderPillLabel(state)}
    </Chip>
  );
}
