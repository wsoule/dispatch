import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useMemo } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { buildFeed } from '../../lib/controlRoom';
import { FEED_STATE_LABEL, FEED_STATE_ORDER } from '../../lib/feedState';
import { Button } from '@/ui/button';
import { StateDot } from '@/ui/chrome/StateDot';

interface MiniOverviewProps {
  data: DispatchProjectData;
  open: boolean;
  onToggle: () => void;
  onOpenRun: (runId: string) => void;
  onReviewRun: (runId: string) => void;
}

/**
 * The Control room, compressed into a rail you keep open.
 *
 * Built from `buildFeed` — the same function the Overview screen itself uses —
 * rather than its own counting pass. Two implementations of "what needs me"
 * would eventually disagree, and the one in the corner of the screen is
 * exactly the one you would not notice going wrong.
 *
 * It shows only the states that need a person, and only while they are
 * non-empty: a rail listing six zeroes is furniture.
 */
export function MiniOverview({
  data,
  open,
  onToggle,
  onOpenRun,
  onReviewRun,
}: MiniOverviewProps) {
  const feed = useMemo(
    () =>
      buildFeed({
        runs: data.runs,
        tasks: data.tasks,
        epics: data.epics,
        readyIds: data.readyIds,
        blockedIds: data.blockedIds,
        mergeQueue: data.mergeQueue,
        pendingApprovals: data.pendingApprovals,
        openQuestions: data.openQuestions,
        query: '',
        activeStates: new Set(),
        collapsed: new Set(),
        expanded: new Set(),
      }),
    [
      data.runs,
      data.tasks,
      data.epics,
      data.readyIds,
      data.blockedIds,
      data.mergeQueue,
      data.pendingApprovals,
      data.openQuestions,
    ]
  );

  // `total` rather than rows.length: buildFeed caps how many rows it returns,
  // and the rail's count should be how much there is, not how much fits.
  const groups = FEED_STATE_ORDER.map((state) => {
    const group = feed.groups.find((g) => g.state === state);
    return { state, rows: group?.rows ?? [], total: group?.total ?? 0 };
  }).filter((g) => g.total > 0);

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onToggle}
        aria-label="Show the overview rail"
        title="Show the overview rail"
        className="text-muted-foreground border-border h-auto shrink-0 rounded-none border-l p-2"
      >
        <PanelRightOpen className="size-4" />
      </Button>
    );
  }

  return (
    <aside className="border-border flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3">
      <div className="flex items-center gap-2">
        <span className="dense-label flex-1">Overview</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onToggle}
          aria-label="Hide the overview rail"
          title="Hide the overview rail"
          className="text-muted-foreground h-auto p-0.5"
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-[12px]">
          Nothing needs you right now.
        </p>
      ) : (
        groups.map(({ state, rows, total }) => (
          <section key={state}>
            <div className="mb-1 flex items-center gap-1.5">
              <StateDot state={state} pulse={state === 'working'} />
              <span className="dense-meta flex-1">
                {FEED_STATE_LABEL[state]}
              </span>
              <span className="dense-meta">{total}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {/* Three per group. The rail is a glance, not a second inbox —
                  the count above already says how much is behind it. */}
              {rows.slice(0, 3).map((row) => (
                <Button
                  key={row.runId}
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    state === 'review'
                      ? onReviewRun(row.runId)
                      : onOpenRun(row.runId)
                  }
                  className="h-auto justify-start truncate rounded px-1.5 py-1 text-left text-[12px] font-normal"
                >
                  {row.title}
                </Button>
              ))}
              {total > 3 && (
                <span className="dense-meta px-1.5">+{total - 3} more</span>
              )}
            </div>
          </section>
        ))
      )}
    </aside>
  );
}
