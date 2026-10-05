import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { BranchEntry, RunMeta, RunState } from '@dispatch/client';
import { ChevronRight, GitBranch, GitMerge } from 'lucide-react';
import { memo, type ReactNode, useCallback, useMemo, useState } from 'react';

import { dagTaskFromDoc } from '../../lib/dagLayout';
import { BranchGraph } from '../graph/BranchGraph';
import { RunStatePill } from '../runs/RunStatePill';
import { cn } from '@/lib/utils';

const OPEN_STORAGE_KEY = 'dispatch:flight-branches-open';

// Folded until someone opens it: the plan above gets the height first.
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // A blocked store only forgets the choice.
  }
}

/** One integration branch and the children merging into it. */
export interface BranchLaneGroup {
  key: string;
  /** A band's name; null for a plan without bands. */
  title: string | null;
  /** `epic/<id>`, or null for a container too broad to share one (a project). */
  integration: string | null;
  tasks: readonly TaskListItem[];
}

interface FlightBranchLaneProps {
  groups: readonly BranchLaneGroup[];
  branches: readonly BranchEntry[];
  latestRunByTaskId: ReadonlyMap<string, RunMeta>;
  liveRunStateByTaskId: ReadonlyMap<string, RunState>;
  refFor: (id: string) => string;
  focusedId: string | null;
  onOpenNode: (id: string) => void;
}

// Where the integration branch stands against its base, from the branch listing.
function integrationNote(entry: BranchEntry | undefined): string {
  if (entry === undefined) return 'not created yet';
  const parts = [`${entry.ahead} ahead`];
  if (entry.behindBase !== undefined && entry.behindBase > 0) {
    parts.push(`${entry.behindBase} behind ${entry.baseBranch ?? 'base'}`);
  }
  return parts.join(', ');
}

const LaneGroup = memo(function LaneGroup({
  group,
  entry,
  accessoryFor,
  refFor,
  focusedId,
  onOpenNode,
}: {
  group: BranchLaneGroup;
  entry: BranchEntry | undefined;
  accessoryFor: (id: string) => ReactNode;
  refFor: (id: string) => string;
  focusedId: string | null;
  onOpenNode: (id: string) => void;
}) {
  const dagTasks = useMemo(
    () => group.tasks.map(dagTaskFromDoc),
    [group.tasks]
  );
  return (
    <div data-slot="flight-branch-group" data-group={group.key}>
      <div className="flex h-7 items-center gap-2 px-3 text-[12px]">
        {group.title !== null && (
          <span className="text-text-secondary truncate font-medium">
            {group.title}
          </span>
        )}
        {group.integration !== null ? (
          <>
            <span className="text-foreground font-book shrink-0 tracking-(--id-tracking)">
              {group.integration}
            </span>
            <span className="shrink-0 text-(--text-muted)">
              {integrationNote(entry)}
            </span>
          </>
        ) : (
          <span className="shrink-0 text-(--text-muted)">
            Children land on the base branch
          </span>
        )}
      </div>
      <BranchGraph
        tasks={dagTasks}
        refFor={refFor}
        accessoryFor={accessoryFor}
        focusedId={focusedId}
        onOpenNode={onOpenNode}
        ariaLabel={`${group.title ?? group.integration ?? 'Plan'} branches`}
        className="pb-1"
      />
    </div>
  );
});

/**
 * Beneath the plan, the same work as git sees it: for each integration branch (one for a
 * milestone; one per milestone band on a project) the git-log `BranchGraph` of the
 * children merging into it, each line trailing its run's branch — live runs as their
 * state pill, merged ones marked merged. Starts folded; opening it is remembered.
 */
export function FlightBranchLane({
  groups,
  branches,
  latestRunByTaskId,
  liveRunStateByTaskId,
  refFor,
  focusedId,
  onOpenNode,
}: FlightBranchLaneProps) {
  const [open, setOpen] = useState(readOpen);
  const epicEntries = useMemo(() => {
    const map = new Map<string, BranchEntry>();
    for (const entry of branches) {
      if (entry.status === 'epic') map.set(entry.branch, entry);
    }
    return map;
  }, [branches]);

  const accessoryFor = useCallback(
    (id: string): ReactNode => {
      const run = latestRunByTaskId.get(id);
      if (run === undefined) return undefined;
      if (liveRunStateByTaskId.has(id))
        return <RunStatePill meta={run} compact />;
      if (run.reviewAction === 'merge') {
        return (
          <span className="text-status-done flex items-center gap-1 text-[12px]">
            <GitMerge aria-hidden className="size-3" />
            merged
          </span>
        );
      }
      return (
        <span className="font-book max-w-56 truncate text-[12px] text-(--text-muted)">
          {run.branch}
        </span>
      );
    },
    [latestRunByTaskId, liveRunStateByTaskId]
  );

  const count = groups.reduce((sum, g) => sum + g.tasks.length, 0);
  return (
    <section
      aria-label="Branches"
      data-slot="flight-branch-lane"
      className="shadow-hairline-top flex max-h-[min(30%,240px)] min-h-9 shrink-0 flex-col"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          writeOpen(!open);
        }}
        className="hover:bg-surface-hover focus-visible:bg-surface-active flex h-9 shrink-0 items-center gap-2 px-4 text-left text-[12px] outline-none"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 text-(--text-muted) transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
        <GitBranch aria-hidden className="size-3.5 text-(--text-muted)" />
        <span className="text-foreground font-medium">Branches</span>
        <span className="font-book text-(--text-muted) tabular-nums">
          {count}
        </span>
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {groups.map((group) => (
            <LaneGroup
              key={group.key}
              group={group}
              entry={
                group.integration === null
                  ? undefined
                  : epicEntries.get(group.integration)
              }
              accessoryFor={accessoryFor}
              refFor={refFor}
              focusedId={focusedId}
              onOpenNode={onOpenNode}
            />
          ))}
        </div>
      )}
    </section>
  );
}
