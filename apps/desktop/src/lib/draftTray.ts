// The app-wide drafts tray's derived view — DOM- and React-free so the sort order, badge
// count, and elapsed-time formatting it depends on are testable without mounting anything.

import type { DraftRecord } from '@dispatch/client';

export type DraftTrayItemState = 'running' | 'ready' | 'failed';

export interface DraftTrayItem {
  id: string;
  state: DraftTrayItemState;
  /** The proposed task's title once ready, the failure message once failed, or the original
   * prompt while still running — whatever is most useful to read at a glance. */
  label: string;
  /** How many tasks the ready proposal carries, for a "+N more" hint one layer up; `null`
   * while running or failed, when there is no settled proposal to count. */
  taskCount: number | null;
  /** Time since the draft was created, formatted for the `now` the view model was built with. */
  elapsed: string;
}

export interface DraftTrayViewModel {
  items: DraftTrayItem[];
  /** Drafts still worth a look — running (in progress) or ready (awaiting review). A failed
   * draft needs dismissing, not celebrating, so it does not inflate this count. */
  badgeCount: number;
}

// running sorts above ready sorts above failed — the tray leads with what is still happening,
// then what is ready to act on, and lets settled failures sink to the bottom.
const STATE_RANK: Record<DraftTrayItemState, number> = {
  running: 0,
  ready: 1,
  failed: 2,
};

function labelFor(draft: DraftRecord): string {
  if (draft.state === 'failed') return draft.error ?? 'Draft failed';
  return draft.proposal?.tasks[0]?.title ?? draft.prompt;
}

/** Formats a duration in milliseconds as a compact "12s"/"3m"/"1h" readout — draft turns run
 * seconds to minutes, so this only ever needs second/minute/hour granularity, never days. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/** Builds the tray's sorted items plus its badge count from the raw drafts list
 * (`GET /api/tasks/drafts`). `now` is a parameter (rather than read internally) so the sort
 * and elapsed strings are pinned to a fixed instant in tests. */
export function draftTrayViewModel(
  drafts: DraftRecord[],
  now: number = Date.now()
): DraftTrayViewModel {
  const items = [...drafts]
    .sort((a, b) => {
      const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
      return rankDiff !== 0 ? rankDiff : b.createdAt.localeCompare(a.createdAt);
    })
    .map((draft) => ({
      id: draft.id,
      state: draft.state,
      label: labelFor(draft),
      taskCount: draft.proposal !== null ? draft.proposal.tasks.length : null,
      elapsed: formatElapsed(now - new Date(draft.createdAt).getTime()),
    }));
  const badgeCount = drafts.filter(
    (d) => d.state === 'running' || d.state === 'ready'
  ).length;
  return { items, badgeCount };
}
