import { FileX } from 'lucide-react';

import { EmptyState } from '@/ui/chrome';

/** A muted centered placeholder for a Diff tab when there's nothing to review yet — a run
 * that's still going (no worktree diff exposed until it's terminal) or a terminal run whose
 * worktree/diff is gone (already reviewed, or genuinely nothing changed). Shared by the task view's
 * Diff tab and TaskDiffTab, which used to each carry their own copy. */
export function DiffEmptyState({ message }: { message: string }) {
  return (
    <EmptyState
      icon={FileX}
      message={message}
      className="h-full justify-center p-0 [&_[data-slot=empty-description]]:text-[13px]"
    />
  );
}
