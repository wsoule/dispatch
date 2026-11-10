import type { TaskListItem, UpdatePatch } from '@dispatch-foo/core/browser';
import type {
  AllocationRun,
  AllocationRunInput,
  ApiClient,
  MilestoneProgress,
  RunMeta,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { recentAllocationsFrom } from '../adapters/allocation';
import { ToastProvider } from '../components/shell/Toasts';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  type PlanningInput,
  PlanningProvider,
  usePlanningContext,
} from '../hooks/usePlanning';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import { AssignMilestones } from './AssignMilestonesDialog';

// Projects' Assign next milestones over a fixture planning: Storefront (lead
// Ana) has a next milestone with one unassigned backlog issue; Search has no
// lead, so it is skipped. A fake client records what the dialog asks for.

afterEach(cleanup);

const DONE_MEANS = '## Description\n\nDone means: it ships.\n';

function fixture(): TaskListItem[] {
  return [
    taskDoc({
      id: 'p-store',
      title: 'Storefront',
      kind: 'project',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc(
      {
        id: 'ms-beta',
        title: 'Beta',
        kind: 'milestone',
        parent: 'p-store',
        dueDate: dayFromNow(9),
      },
      DONE_MEANS
    ),
    taskDoc({
      id: 't-pay',
      title: 'Take payments',
      parent: 'ms-beta',
      status: 'backlog',
      assignee: 'none',
    }),
    taskDoc({
      id: 't-cart',
      title: 'Persist the cart',
      parent: 'ms-beta',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc({
      id: 'p-search',
      title: 'Search',
      kind: 'project',
      status: 'working',
      assignee: 'none',
    }),
  ];
}

interface FakeLog {
  updates: { id: string; patch: UpdatePatch }[];
  comments: string[];
  recorded: AllocationRunInput[];
}

function fakeClient(log: FakeLog, refuse: string[] = []): ApiClient {
  const runs: AllocationRun[] = [];
  return {
    recordAllocationRun: (input: AllocationRunInput) => {
      log.recorded.push(input);
      const run: AllocationRun = {
        ...input,
        id: `ar-${runs.length}`,
        trigger: 'manual',
        at: new Date().toISOString(),
        by: 'human:ana',
        counts: {
          assigned: input.items.filter((i) => i.outcome === 'assigned').length,
          wouldAssign: input.items.filter((i) => i.outcome === 'would_assign')
            .length,
          failed: input.items.filter((i) => i.outcome === 'failed').length,
          blocked: input.projects.filter((p) => p.outcome === 'blocked').length,
          skipped: 0,
        },
      };
      runs.unshift(run);
      return Promise.resolve(run);
    },
    updateTask: (id: string, patch: UpdatePatch) => {
      if (refuse.includes(id)) return Promise.reject(new Error('locked'));
      log.updates.push({ id, patch });
      return Promise.resolve({});
    },
    addTaskComment: (_id: string, input: { body: string }) => {
      log.comments.push(input.body);
      return Promise.resolve({});
    },
  } as unknown as ApiClient;
}

function planningInput(): PlanningInput {
  return {
    tasks: fixture(),
    config: null,
    people: [{ ref: 'human:ana', name: 'Ana' }],
    executors: null,
    me: 'human:ana',
    linearLinks: {},
    latestRunByTaskId: new Map<string, RunMeta>(),
    milestoneProgressById: new Map<string, MilestoneProgress>(),
  };
}

function Host({ data }: { data: DispatchProjectData }) {
  const planning = usePlanningContext();
  return planning === null ? null : (
    <AssignMilestones data={data} planning={planning} />
  );
}

function mount(log: FakeLog, tier: 'operator' | 'request' = 'operator') {
  const data = {
    client: fakeClient(log),
    myTier: tier,
  } as unknown as DispatchProjectData;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <PlanningProvider data={planningInput()}>
          <Host data={data} />
        </PlanningProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function newLog(): FakeLog {
  return { updates: [], comments: [], recorded: [] };
}

describe('AssignMilestones', () => {
  test('the button previews the count; the dialog lists what is assigned and what is skipped', () => {
    mount(newLog());
    fireEvent.click(
      screen.getByRole('button', { name: 'Assign next milestones · 1' })
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Assign next milestones',
    });
    const store = within(dialog).getByRole('region', { name: 'Storefront' });
    expect(within(store).getByText('Take payments')).toBeTruthy();
    expect(within(store).getByText('Ana')).toBeTruthy();
    const skipped = within(dialog).getByRole('region', { name: 'Skipped' });
    expect(within(skipped).getByText('Search')).toBeTruthy();
    expect(within(skipped).getByText('Blocked')).toBeTruthy();
    expect(within(skipped).getByText('Project has no lead')).toBeTruthy();
  });

  test('applies: assigns, moves out of Backlog, comments, records', async () => {
    const log = newLog();
    mount(log);
    fireEvent.click(
      screen.getByRole('button', { name: 'Assign next milestones · 1' })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assign 1 issue' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(log.recorded).toHaveLength(1));
    expect(log.updates).toHaveLength(1);
    expect(log.updates[0]?.id).toBe('t-pay');
    expect(log.updates[0]?.patch.assignee).toBe('human:ana');
    expect(log.updates[0]?.patch.status).toBeDefined();
    expect(log.comments[0]).toContain('you lead Storefront');
    expect(log.recorded[0]?.mode).toBe('applied');
    expect(log.recorded[0]?.items[0]?.outcome).toBe('assigned');
  });

  test('a request-tier window only previews', () => {
    mount(newLog(), 'request');
    fireEvent.click(
      screen.getByRole('button', { name: 'Assign next milestones · 1' })
    );
    expect(screen.queryByRole('button', { name: /^Assign 1/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('recentAllocationsFrom', () => {
  const run: AllocationRun = {
    id: 'ar-1',
    trigger: 'manual',
    at: '2026-11-06T10:00:00.000Z',
    by: 'human:ana',
    mode: 'applied',
    counts: { assigned: 2, wouldAssign: 0, failed: 1, blocked: 1, skipped: 0 },
    projects: [],
    items: [
      {
        issueId: 't-1',
        identifier: 't-1',
        title: 'One',
        projectId: 'p',
        projectName: 'P',
        milestoneId: 'm',
        milestoneName: 'M',
        assigneeId: 'human:ana',
        assigneeName: 'Ana',
        fromStatus: 'backlog',
        toStatus: 'ready',
        outcome: 'assigned',
        note: null,
      },
      {
        issueId: 't-2',
        identifier: 't-2',
        title: 'Two',
        projectId: 'p',
        projectName: 'P',
        milestoneId: 'm',
        milestoneName: 'M',
        assigneeId: 'human:ana',
        assigneeName: 'Ana',
        fromStatus: 'backlog',
        toStatus: 'ready',
        outcome: 'failed',
        note: 'locked',
      },
    ],
  };

  test('only assigned items of applied runs count as recent allocations', () => {
    expect(recentAllocationsFrom([run])).toEqual([
      {
        issueId: 't-1',
        assigneeId: 'human:ana',
        projectId: 'p',
        milestoneId: 'm',
        at: run.at,
      },
    ]);
    expect(recentAllocationsFrom([{ ...run, mode: 'dry_run' }])).toEqual([]);
  });
});
