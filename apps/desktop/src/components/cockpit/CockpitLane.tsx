import type { MergeQueueEntry } from '@dispatch/client';
import { CircleDot, Hourglass, LoaderCircle } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  CockpitItem,
  CockpitLaneId,
  RosterHeader,
} from '../../lib/cockpit';
import type { FlatRow } from '../../lib/virtualRows';
import type { FlightPlan } from '../flightplan/flightPlan';
import { VirtualRows, type VirtualRowsHandle } from '../virtual/VirtualRows';
import { CockpitRow, RosterHeaderRow } from './CockpitRow';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';

export type CockpitRowModel = FlatRow<RosterHeader, CockpitItem>;

const LANE_TITLE: Record<CockpitLaneId, string> = {
  ready: 'Ready for you',
  flight: 'In flight',
  needs: 'Needs you',
};

// Each lane's hue is the tier its rows belong to: resting, the machine's, yours.
const LANE_TINT: Record<CockpitLaneId, string> = {
  ready: 'var(--state-ready-fg)',
  flight: 'var(--state-working-fg)',
  needs: 'var(--state-waiting-fg)',
};

const LANE_ICON: Record<CockpitLaneId, typeof CircleDot> = {
  ready: CircleDot,
  flight: LoaderCircle,
  needs: Hourglass,
};

const LANE_EMPTY: Record<CockpitLaneId, string> = {
  ready: 'Nothing is waiting to start. Plan work, or look at the team’s queue.',
  flight: 'No agents running. Press D on a ready task to send one.',
  needs: 'Nothing is waiting on you.',
};

const ROW_HEIGHT = 36;
const FANOUT_ROW_HEIGHT = 52;
const ROSTER_HEADER_HEIGHT = 28;
const rowHeight = (row: CockpitRowModel) =>
  row.kind === 'header'
    ? ROSTER_HEADER_HEIGHT
    : row.item.kind === 'fanout'
      ? FANOUT_ROW_HEIGHT
      : ROW_HEIGHT;
const rowKey = (row: CockpitRowModel) => row.key;

function LaneIcon({ lane }: { lane: CockpitLaneId }) {
  const Icon = LANE_ICON[lane];
  return (
    <Icon aria-hidden className="size-3.5" style={{ color: LANE_TINT[lane] }} />
  );
}

interface CockpitLaneProps {
  lane: CockpitLaneId;
  rows: readonly CockpitRowModel[];
  /** Item rows only — the header count. */
  count: number;
  /** The keyboard cursor's row in this lane, or null when the cursor is elsewhere. */
  focusedKey: string | null;
  plans: ReadonlyMap<string, FlightPlan>;
  /** Tasks whose run is in the merge queue — their rows carry a `Landing` badge. */
  landingByTaskId: ReadonlyMap<string, MergeQueueEntry>;
  loading: boolean;
  onActivate: (key: string) => void;
  onDispatch?: (taskId: string) => void;
  /** Right of the lane's title: In flight's way into the Live view. */
  actions?: ReactNode;
  className?: string;
}

/**
 * One Cockpit lane: a tinted 36px header over its own virtualized scroller. The cursor's
 * row stays mounted and is scrolled in whenever the cursor moves onto it.
 */
export function CockpitLane({
  lane,
  rows,
  count,
  focusedKey,
  plans,
  landingByTaskId,
  loading,
  onActivate,
  onDispatch,
  actions,
  className,
}: CockpitLaneProps) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const handle = useRef<VirtualRowsHandle>(null);
  useEffect(() => {
    if (focusedKey !== null) handle.current?.scrollToKey(focusedKey);
  }, [focusedKey, scroller]);
  const pinnedKeys = useMemo(
    () => (focusedKey === null ? [] : [focusedKey]),
    [focusedKey]
  );
  const renderRow = useCallback(
    (row: CockpitRowModel) =>
      row.kind === 'header' ? (
        <RosterHeaderRow header={row.header} />
      ) : (
        <CockpitRow
          item={row.item}
          focused={row.key === focusedKey}
          plan={
            row.item.kind === 'fanout'
              ? plans.get(row.item.progress.epicId)
              : undefined
          }
          landing={landingByTaskId.get(row.item.taskId)?.state}
          onActivate={onActivate}
          onDispatch={onDispatch}
        />
      ),
    [focusedKey, plans, landingByTaskId, onActivate, onDispatch]
  );
  return (
    <div
      data-lane={lane}
      className={cn('flex min-h-0 min-w-0 flex-col', className)}
    >
      <div className="px-2 pt-2">
        <GroupHeader
          tint={LANE_TINT[lane]}
          icon={<LaneIcon lane={lane} />}
          name={LANE_TITLE[lane]}
          count={count}
          actions={actions}
        />
      </div>
      <div
        ref={setScroller}
        className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-[12px]">
            {loading ? 'Loading…' : LANE_EMPTY[lane]}
          </p>
        ) : (
          <VirtualRows
            rows={rows}
            rowKey={rowKey}
            estimateSize={rowHeight}
            scrollElement={scroller}
            pinnedKeys={pinnedKeys}
            handleRef={handle}
            renderRow={renderRow}
          />
        )}
      </div>
    </div>
  );
}

/** A lane folded to a 40px strip while the split pane is open: its glyph, a vertical
 * name and the count; a click makes it the open lane. */
export function CollapsedLane({
  lane,
  count,
  onOpen,
}: {
  lane: CockpitLaneId;
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-lane-strip={lane}
      aria-label={`${LANE_TITLE[lane]}, ${count}`}
      onClick={onOpen}
      className="hover:bg-surface-hover flex w-10 shrink-0 flex-col items-center gap-2 pt-3.5 transition-colors duration-100"
    >
      <LaneIcon lane={lane} />
      <span className="text-muted-foreground text-[12px] font-medium whitespace-nowrap [writing-mode:vertical-rl]">
        {LANE_TITLE[lane]}
      </span>
      <span className="font-book text-muted-foreground text-[12px] tabular-nums">
        {count}
      </span>
    </button>
  );
}
