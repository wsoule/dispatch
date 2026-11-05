import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { BranchEntry, RunMeta, RunState } from '@dispatch/client';
import { cx, Disclosure } from '@dispatch/ui';
import { ChevronRight, GitBranch, GitMerge } from 'lucide-react';
import { memo, type ReactNode, useCallback, useMemo, useState } from 'react';

import { dagTaskFromDoc } from '../../lib/dagLayout';
import { BranchGraph } from '../graph/BranchGraph';
import { RunStatePill } from '../runs/RunStatePill';
import styles from './FlightBranchLane.module.css';

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
  /** `milestone/<id>`, or null for a container too broad to share one (a project). */
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
      <div className={styles.groupHead}>
        {group.title !== null && (
          <span className={styles.groupTitle}>{group.title}</span>
        )}
        {group.integration !== null ? (
          <>
            <span className={styles.integration}>{group.integration}</span>
            <span className={styles.note}>{integrationNote(entry)}</span>
          </>
        ) : (
          <span className={styles.note}>Children land on the base branch</span>
        )}
      </div>
      <BranchGraph
        tasks={dagTasks}
        refFor={refFor}
        accessoryFor={accessoryFor}
        focusedId={focusedId}
        onOpenNode={onOpenNode}
        ariaLabel={`${group.title ?? group.integration ?? 'Plan'} branches`}
        className={styles.graph}
      />
    </div>
  );
});

/**
 * Beneath the plan, the same work as git sees it: for each integration branch (one for a
 * milestone; one per milestone band on a project) the git-log `BranchGraph` of the
 * children merging into it, each line trailing its run's branch — live runs as their
 * state pill, merged ones marked merged. A library Disclosure, controlled here: it starts
 * folded, and opening or closing it is remembered under `OPEN_STORAGE_KEY`.
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
  const milestoneEntries = useMemo(() => {
    const map = new Map<string, BranchEntry>();
    for (const entry of branches) {
      if (entry.status === 'milestone') map.set(entry.branch, entry);
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
          <span className={styles.merged}>
            <GitMerge aria-hidden size={14} strokeWidth={1.8} />
            merged
          </span>
        );
      }
      return <span className={styles.branch}>{run.branch}</span>;
    },
    [latestRunByTaskId, liveRunStateByTaskId]
  );

  const count = groups.reduce((sum, g) => sum + g.tasks.length, 0);
  return (
    <section
      aria-label="Branches"
      data-slot="flight-branch-lane"
      className={styles.lane}
    >
      <Disclosure
        data-slot="flight-branch-fold"
        variant="plain"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          writeOpen(next);
        }}
        trigger={({ props }) => (
          <button {...props} className={styles.trigger}>
            <ChevronRight
              aria-hidden
              size={14}
              strokeWidth={1.8}
              className={styles.chevron}
            />
            <GitBranch
              aria-hidden
              size={14}
              strokeWidth={1.8}
              className={styles.icon}
            />
            <span className={styles.label}>Branches</span>
            <span className={cx(styles.count, 'num')}>{count}</span>
          </button>
        )}
      >
        {groups.map((group) => (
          <LaneGroup
            key={group.key}
            group={group}
            entry={
              group.integration === null
                ? undefined
                : milestoneEntries.get(group.integration)
            }
            accessoryFor={accessoryFor}
            refFor={refFor}
            focusedId={focusedId}
            onOpenNode={onOpenNode}
          />
        ))}
      </Disclosure>
    </section>
  );
}
