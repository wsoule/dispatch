import { FlaskConical, GitPullRequestArrow, Hammer } from 'lucide-react';

import type { RunKind } from '../../lib/apiTypes';
import { runKindLabel } from '../../lib/runKind';

const RUN_KIND_ICON: Record<RunKind, typeof Hammer> = {
  execute: Hammer,
  review: GitPullRequestArrow,
  verify: FlaskConical,
};

/** A run's kind (execute/review/verify), so the three don't render as
 *  identical rows next to the state pill they always sit beside. */
export function RunKindBadge({ kind }: { kind: RunKind | undefined }) {
  const resolved = kind ?? 'execute';
  const Icon = RUN_KIND_ICON[resolved];
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[11px]">
      <Icon className="size-3" />
      {runKindLabel(kind)}
    </span>
  );
}
