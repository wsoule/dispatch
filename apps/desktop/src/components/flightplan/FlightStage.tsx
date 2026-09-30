import type { BranchEntry, RunMeta, RunState } from '@dispatch/client';
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';

import { isTypingTarget } from '../../hooks/useGlobalKeyboard';
import type { TaskTab } from '../../lib/appNav';
import { TaskPane } from '../tasks/TaskPane';
import { type BranchLaneGroup, FlightBranchLane } from './FlightBranchLane';
import {
  type FlightBandView,
  FlightCanvas,
  type FlightEdgeView,
  type FlightWaveView,
  WAVE_HEADER_HEIGHT,
} from './FlightCanvas';
import { type CullWindow, cullWindow, sameWindow } from './flightCull';
import {
  type FlightNavIndex,
  moveFlightCursor,
  resolveFlightKey,
} from './flightKeys';
import type { FlightLayout } from './flightLayout';
import { flightNodeDomId, type FlightNodeView } from './FlightNodeCard';

/** What the branch lane reads beyond its groups. */
export interface FlightLaneData {
  branches: readonly BranchEntry[];
  latestRunByTaskId: ReadonlyMap<string, RunMeta>;
  liveRunStateByTaskId: ReadonlyMap<string, RunState>;
  refFor: (id: string) => string;
}

interface FlightStageProps {
  /** The container's title, for the canvas's accessible name. */
  title: string;
  layout: FlightLayout;
  nav: FlightNavIndex;
  nodes: readonly FlightNodeView[];
  edges: readonly FlightEdgeView[];
  waves: readonly FlightWaveView[];
  bands: readonly FlightBandView[] | null;
  /** Where the cursor sits until someone moves it. */
  defaultCursor: string | null;
  /** The branch lane's groups; null leaves the lane out. */
  laneGroups: readonly BranchLaneGroup[] | null;
  lane: FlightLaneData;
  canDispatch: (id: string) => boolean;
  onDispatch: (id: string) => void;
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  onPeekTask?: (taskId: string) => void;
  openIn: 'pane' | 'page';
  focusOnMount: boolean;
}

/**
 * The interactive half of the Flight Plan: the canvas, the branch lane and the split pane,
 * with the keyboard cursor held here so moving it re-renders this subtree alone — the
 * header, and every derivation above it, stay put. Its props are all memoized upstream.
 */
export const FlightStage = memo(function FlightStage({
  title,
  layout,
  nav,
  nodes,
  edges,
  waves,
  bands,
  defaultCursor,
  laneGroups,
  lane,
  canDispatch,
  onDispatch,
  onOpenTask,
  onPeekTask,
  openIn,
  focusOnMount,
}: FlightStageProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  // Whether the canvas holds keyboard focus; with no cursor yet it then marks a default.
  const [hasFocus, setHasFocus] = useState(false);
  const [paneTaskId, setPaneTaskId] = useState<string | null>(null);
  // The pane catches up at a lower priority so arrowing through the plan never waits on it.
  const deferredPaneTaskId = useDeferredValue(paneTaskId);
  const canvasRef = useRef<HTMLDivElement>(null);

  const focusedId =
    cursor !== null && layout.boxes.has(cursor)
      ? cursor
      : hasFocus
        ? defaultCursor
        : null;

  // The pane follows the cursor while it is open.
  useEffect(() => {
    if (paneTaskId !== null && cursor !== null && cursor !== paneTaskId) {
      setPaneTaskId(cursor);
    }
  }, [cursor, paneTaskId]);

  useEffect(() => {
    if (focusOnMount) canvasRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  // The drawn window follows the scroll, re-culling only as it crosses a tile.
  const [cull, setCull] = useState<CullWindow | null>(null);
  useEffect(() => {
    const scroller = canvasRef.current;
    if (scroller === null) return;
    const update = () => {
      const next = cullWindow(
        {
          left: scroller.scrollLeft,
          top: scroller.scrollTop,
          width: scroller.clientWidth,
          height: scroller.clientHeight,
        },
        WAVE_HEADER_HEIGHT
      );
      setCull((prev) => (sameWindow(prev, next) ? prev : next));
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  // The host's open verb changes identity with its data; read it through a ref so
  // `activate` stays stable and a data change never re-renders every card.
  const openTaskRef = useRef(onOpenTask);
  useEffect(() => {
    openTaskRef.current = onOpenTask;
  }, [onOpenTask]);
  const activate = useCallback(
    (id: string) => {
      setCursor(id);
      if (openIn === 'page') openTaskRef.current(id);
      else setPaneTaskId(id);
      canvasRef.current?.focus({ preventScroll: true });
    },
    [openIn]
  );

  function scrollToNode(id: string) {
    requestAnimationFrame(() =>
      document
        .getElementById(flightNodeDomId(id))
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    );
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (isTypingTarget(e.target)) return;
    // Enter or Space on a control inside the plan (a band's buttons) belongs to it.
    if (
      e.target !== e.currentTarget &&
      (e.target as HTMLElement).closest(
        'button, a, input, select, textarea'
      ) !== null &&
      (e.key === 'Enter' || e.key === ' ')
    ) {
      return;
    }
    const command = resolveFlightKey(e);
    if (command === null) return;
    switch (command) {
      case 'up':
      case 'down':
      case 'left':
      case 'right': {
        e.preventDefault();
        const next = moveFlightCursor(nav, focusedId, command);
        if (next !== null) {
          setCursor(next);
          scrollToNode(next);
        }
        return;
      }
      case 'open':
        if (focusedId === null) return;
        e.preventDefault();
        activate(focusedId);
        return;
      case 'open-full':
        if (focusedId === null) return;
        e.preventDefault();
        onOpenTask(focusedId);
        return;
      case 'peek':
        if (focusedId === null || onPeekTask === undefined) return;
        e.preventDefault();
        onPeekTask(focusedId);
        return;
      case 'dispatch':
        if (focusedId === null || !canDispatch(focusedId)) return;
        e.preventDefault();
        onDispatch(focusedId);
        return;
      case 'close':
        if (paneTaskId === null) return;
        // The shell's Escape would also navigate back.
        e.preventDefault();
        e.stopPropagation();
        setPaneTaskId(null);
        return;
    }
  }

  const split = openIn === 'pane' && deferredPaneTaskId !== null;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={canvasRef}
          role="group"
          aria-label={`Flight plan for ${title}`}
          aria-activedescendant={
            focusedId === null ? undefined : flightNodeDomId(focusedId)
          }
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onFocus={() => setHasFocus(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setHasFocus(false);
          }}
          // The focused node carries the ring, so the canvas's own would only frame it.
          style={{ outline: 'none' }}
          className="relative min-h-0 flex-1 overflow-auto"
        >
          <FlightCanvas
            layout={layout}
            nodes={nodes}
            edges={edges}
            waves={waves}
            bands={bands}
            focusedId={focusedId}
            onActivate={activate}
            cull={cull}
          />
        </div>
        {laneGroups !== null && (
          <FlightBranchLane
            groups={laneGroups}
            branches={lane.branches}
            latestRunByTaskId={lane.latestRunByTaskId}
            liveRunStateByTaskId={lane.liveRunStateByTaskId}
            refFor={lane.refFor}
            focusedId={focusedId}
            onOpenNode={activate}
          />
        )}
      </div>
      {split && (
        <div className="shadow-hairline-left w-[min(520px,45%)] min-w-0 shrink-0">
          <TaskPane
            taskId={deferredPaneTaskId}
            onClose={() => {
              setPaneTaskId(null);
              canvasRef.current?.focus({ preventScroll: true });
            }}
            onExpand={() => onOpenTask(deferredPaneTaskId)}
          />
        </div>
      )}
    </div>
  );
});
