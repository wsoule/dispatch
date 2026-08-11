import type { BranchEntry, RunMeta } from '@dispatch/client';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { LandedView } from './LandedView';

/** A `DispatchProjectData` stub carrying only what LandedView reads. */
function projectWith(
  branches: BranchEntry[],
  runs: RunMeta[] = []
): DispatchProjectData {
  return {
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {},
    retryEnsureDispatchd: () => {},
    branches,
    branchesLoading: false,
    handleRefreshBranches: async () => {},
    runs,
  } as unknown as DispatchProjectData;
}

function branch(overrides: Partial<BranchEntry>): BranchEntry {
  return {
    branch: 'dispatch/t-x-r1',
    worktreeExists: false,
    dirty: false,
    ahead: 1,
    mergedIntoBase: false,
    pushedToOrigin: false,
    status: 'reviewable',
    baseBranch: 'main',
    ...overrides,
  };
}

function mergedRun(overrides: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-x',
    taskTitle: 'Landed task',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-x-r1',
    baseBranch: 'main',
    worktreePath: '',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    reviewedAt: '2026-08-10T12:00:00.000Z',
    reviewAction: 'merge',
    mergeCommit: 'abc123',
    ...overrides,
  } as RunMeta;
}

// The page's core promise: one screen, every run branch, each in the bucket
// its git/registry state puts it in — merged rows sourced from the run
// registry (their refs are deleted), with pushed and local-only told apart.
test('buckets run branches and distinguishes pushed from local-only merges', () => {
  render(
    <LandedView
      data={projectWith(
        [
          branch({ branch: 'dispatch/t-c-r1', behindBase: 3 }),
          branch({ branch: 'dispatch/t-d-r1', status: 'orphan' }),
        ],
        [
          mergedRun({ id: 'r-pushed', pushedToOrigin: true }),
          mergedRun({
            id: 'r-local',
            branch: 'dispatch/t-b-r1',
            pushedToOrigin: false,
          }),
        ]
      )}
      onOpenRun={() => {}}
    />
  );

  // One section per bucket, with the two merged ones visually distinct.
  expect(screen.getByText('Merged & pushed')).not.toBeNull();
  expect(screen.getByText('On origin')).not.toBeNull();
  expect(screen.getByText('Merged locally — not pushed')).not.toBeNull();
  expect(screen.getByText('Not pushed')).not.toBeNull();
  expect(screen.getByText('Awaiting review')).not.toBeNull();
  // Section header plus the row's own chip both carry the label.
  expect(screen.getAllByText('Abandoned')).toHaveLength(2);

  // Merged rows exist even though no branch ref survives for them.
  expect(screen.getByText('r-pushed')).not.toBeNull();
  expect(screen.getByText('r-local')).not.toBeNull();

  // The unmerged row says how far the base has moved past it.
  expect(screen.getByText('3 commits behind main')).not.toBeNull();

  // The header counts what is still out: awaiting-review + abandoned.
  expect(screen.getByText('2 branches still out')).not.toBeNull();
});

test('an empty project says so instead of rendering five empty sections', () => {
  render(<LandedView data={projectWith([])} onOpenRun={() => {}} />);

  expect(screen.getByText(/No run branches/)).not.toBeNull();
  expect(screen.queryByText('Merged & pushed')).toBeNull();
});
