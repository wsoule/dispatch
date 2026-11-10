import { EmptyState } from '@dispatch/ui';
import { FileX } from 'lucide-react';

import styles from './DiffEmptyState.module.css';

/** A muted centered placeholder for a Diff tab when there's nothing to review yet — a run
 * that's still going (no worktree diff exposed until it's terminal) or a terminal run whose
 * worktree/diff is gone (already reviewed, or genuinely nothing changed). Shared by the task view's
 * Diff tab and TaskDiffTab, which used to each carry their own copy. The `.fill` wrapper fills
 * the pane and centres the library EmptyState in it (DiffSurface's `.state` pattern), and keeps
 * the `data-slot="empty-state"` hook the legacy placeholder carried. */
export function DiffEmptyState({ message }: { message: string }) {
  return (
    <div className={styles.fill} data-slot="empty-state">
      <EmptyState icon={<FileX size={22} strokeWidth={1.8} />}>
        {message}
      </EmptyState>
    </div>
  );
}
