import type {
  ConfirmResult,
  PlanProposal,
  PlanRecord,
  PlanSummary,
} from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig } from '../components/settings/fixtures.test-helper';
import { ToastProvider } from '../components/shell/Toasts';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { PlansView } from './PlansView';

/** A two-task proposal, with the milestone unless `epic` is false. */
function proposal(epic = true): PlanProposal {
  return {
    ...(epic && {
      epic: { title: 'Payments', description: 'Charge and refund.' },
    }),
    tasks: [
      {
        title: 'Charge card',
        description: '',
        acceptanceCriteria: [],
        blockedByIndices: [],
        priority: 'medium',
      },
      {
        title: 'Refund flow',
        description: '',
        acceptanceCriteria: [],
        blockedByIndices: [0],
        priority: 'medium',
      },
    ],
  };
}

function planRecord(withEpic = true): PlanRecord {
  return {
    id: 'p-1',
    prompt: 'Build payments',
    plannerName: 'planner',
    role: 'plan',
    state: 'ready',
    messages: [
      { role: 'user', text: 'Build payments', at: '2026-09-20T00:00:00.000Z' },
      {
        role: 'assistant',
        text: 'Here is a plan.',
        at: '2026-09-20T00:00:01.000Z',
      },
    ],
    proposal: proposal(withEpic),
    questions: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:01.000Z',
  };
}

function summary(id: string, epicId?: string): PlanSummary {
  return {
    id,
    prompt: `Plan ${id}`,
    state: 'ready',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:01.000Z',
    confirmedAt: epicId !== undefined ? '2026-09-20T00:00:02.000Z' : undefined,
    ...(epicId !== undefined && { epicId }),
  };
}

/** What the view asked of the hook and its navigation callbacks, in order. */
interface Log {
  confirmed: PlanProposal[];
  planIds: (string | null)[];
  milestones: [string, { dispatch?: boolean } | undefined][];
  board: number;
}

/** A `DispatchProjectData` stub with a ready plan open, carrying only what PlansView reads. */
function dataWith(
  log: Log,
  options: {
    record?: PlanRecord;
    plans?: PlanSummary[];
    confirmResult?: ConfirmResult;
  } = {}
): DispatchProjectData {
  const record = options.record ?? planRecord();
  return {
    client: {},
    portLoading: false,
    portError: false,
    config: testConfig,
    planId: record.id,
    planRecord: record,
    plans: options.plans ?? [],
    setPlanId: (id: string | null) => log.planIds.push(id),
    handleSubmitPrompt: () => Promise.resolve('p-2'),
    handleSendPlanMessage: () => Promise.resolve(record),
    handleConfirmPlan: (p: PlanProposal) => {
      log.confirmed.push(p);
      return Promise.resolve(
        options.confirmResult ?? { epicId: 'e-1', taskIds: ['t-1', 't-2'] }
      );
    },
  } as unknown as DispatchProjectData;
}

function renderPlans(data: DispatchProjectData, log: Log) {
  return render(
    <ToastProvider>
      <PlansView
        data={data}
        projectName="Dispatch"
        onGoToBoard={() => (log.board += 1)}
        onOpenMilestone={(epicId, opts) => log.milestones.push([epicId, opts])}
      />
    </ToastProvider>
  );
}

function newLog(): Log {
  return { confirmed: [], planIds: [], milestones: [], board: 0 };
}

// A confirm resolves a tick later, and sonner mounts the toast after that.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('confirming a plan with an epic toasts the milestone, links to it, and returns to the composer', async () => {
  const log = newLog();
  renderPlans(dataWith(log), log);
  expect(screen.getByText('Charge card')).not.toBeNull();

  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));
  });
  expect(log.confirmed).toHaveLength(1);
  expect(log.confirmed[0]?.epic?.title).toBe('Payments');
  expect(await screen.findByText('Milestone created · 2 tasks')).not.toBeNull();
  // The review list is gone and the plan closed: back to the composer.
  expect(screen.queryByRole('button', { name: 'Create tasks' })).toBeNull();
  expect(log.planIds).toEqual([null]);

  fireEvent.click(screen.getByRole('button', { name: 'Open milestone' }));
  expect(log.milestones).toEqual([['e-1', undefined]]);
  expect(log.board).toBe(0);
});

test('Create & send agents… confirms, then opens the milestone with the dialog', async () => {
  const log = newLog();
  renderPlans(dataWith(log), log);
  await settle(() => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & send agents…' })
    );
  });
  expect(log.confirmed).toHaveLength(1);
  expect(log.milestones).toEqual([['e-1', { dispatch: true }]]);
  expect(log.planIds).toEqual([null]);
  expect(await screen.findByText('Milestone created · 2 tasks')).not.toBeNull();
});

test('a flat plan has no send-agents button and toasts View board', async () => {
  const log = newLog();
  renderPlans(
    dataWith(log, {
      record: planRecord(false),
      confirmResult: { taskIds: ['t-1', 't-2'] },
    }),
    log
  );
  expect(
    screen.queryByRole('button', { name: 'Create & send agents…' })
  ).toBeNull();

  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));
  });
  expect(await screen.findByText('2 tasks created')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View board' }));
  expect(log.board).toBe(1);
  expect(log.milestones).toEqual([]);
});

test('both confirm buttons follow the one readiness rule', () => {
  const log = newLog();
  const running: PlanRecord = { ...planRecord(), state: 'running' };
  // The draft on screen is the previous turn's; a running record cannot be confirmed.
  const { rerender } = renderPlans(dataWith(log), log);
  rerender(
    <ToastProvider>
      <PlansView
        data={dataWith(log, { record: running })}
        onGoToBoard={() => {}}
        onOpenMilestone={() => {}}
      />
    </ToastProvider>
  );
  expect(
    screen
      .getByRole('button', { name: 'Create tasks' })
      .hasAttribute('disabled')
  ).toBe(true);
  expect(
    screen
      .getByRole('button', { name: 'Create & send agents…' })
      .hasAttribute('disabled')
  ).toBe(true);
});

test('a history row with an epic links → milestone without opening the entry', () => {
  const log = newLog();
  renderPlans(
    dataWith(log, { plans: [summary('p-9', 'e-9'), summary('p-8')] }),
    log
  );
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('→ milestone');
  expect(rows[0]?.textContent).toContain('confirmed');
  expect(rows[1]?.textContent).not.toContain('→ milestone');

  fireEvent.click(screen.getByRole('button', { name: '→ milestone' }));
  expect(log.milestones).toEqual([['e-9', undefined]]);
  expect(log.planIds).toEqual([]);

  fireEvent.click(rows[1]);
  expect(log.planIds).toEqual(['p-8']);
});

test('under Tasks the page leads back with ‹ tasks; Classic has no back', () => {
  const log = newLog();
  const { unmount } = renderPlans(dataWith(log), log);
  expect(screen.queryByTestId('tasks-back')).toBeNull();
  unmount();
  let back = 0;
  render(
    <ToastProvider>
      <PlansView
        data={dataWith(log)}
        onGoToBoard={() => {}}
        onOpenMilestone={() => {}}
        onBack={() => (back += 1)}
      />
    </ToastProvider>
  );
  fireEvent.click(screen.getByTestId('tasks-back'));
  expect(back).toBe(1);
});
