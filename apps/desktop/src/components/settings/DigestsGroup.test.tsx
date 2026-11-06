import type { ConfigPatch } from '@dispatch-foo/core/browser';
import type {
  ApiClient,
  MilestoneProgress,
  PlanningDigestRecord,
  RunMeta,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { PlanningProvider } from '../../hooks/usePlanning';
import { dayFromNow } from '../../lib/taskDates';
import { taskDoc } from '../../lib/taskDoc.test-helper';
import { DigestsGroup } from './DigestsGroup';
import { testConfig } from './fixtures.test-helper';

// Settings → Planning → Warnings: the preview is worked out from the planning
// (Storefront's Beta is three days overdue, so its lead Ana would hear about
// it), and the log lists what the daemon sent.

const TASKS = [
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
      dueDate: dayFromNow(-3),
    },
    '## Description\n\nDone means: it ships.\n'
  ),
  taskDoc({
    id: 't-pay',
    title: 'Take payments',
    parent: 'ms-beta',
    status: 'ready',
    assignee: 'human:ana',
  }),
];

const LOGGED: PlanningDigestRecord = {
  id: 1,
  at: new Date().toISOString(),
  delivery: 'webhook',
  error: null,
  digest: {
    recipientId: 'human:ana',
    recipientName: 'Ana',
    day: dayFromNow(0),
    items: [
      {
        notice: {
          kind: 'at_risk',
          subjectId: 'ms-beta',
          projectId: 'p-store',
          milestoneId: 'ms-beta',
        },
        projectName: 'Storefront',
        milestoneName: 'Beta',
        openCount: 1,
        unassignedCount: 0,
        lines: ['Behind pace'],
      },
    ],
  },
};

function mount() {
  const saved: ConfigPatch[] = [];
  const client = {
    fetchPlanningDigests: () => Promise.resolve([LOGGED]),
  } as unknown as ApiClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PlanningProvider
        data={{
          tasks: TASKS,
          config: null,
          people: [{ ref: 'human:ana', name: 'Ana' }],
          executors: null,
          me: 'human:ana',
          linearLinks: {},
          latestRunByTaskId: new Map<string, RunMeta>(),
          milestoneProgressById: new Map<string, MilestoneProgress>(),
        }}
      >
        <DigestsGroup
          config={testConfig}
          data={{ client, port: 1 }}
          onSave={(patch) => Promise.resolve(void saved.push(patch))}
        />
      </PlanningProvider>
    </QueryClientProvider>
  );
  return saved;
}

test('the preview says who would hear about the overdue milestone', async () => {
  mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await Promise.resolve();
  });
  const dialog = screen.getByRole('dialog', { name: "Today's digests" });
  const forAna = within(dialog).getByRole('region', { name: 'For Ana' });
  expect(within(forAna).getByText('Storefront · Beta')).toBeTruthy();
  expect(within(forAna).getByText('Overdue')).toBeTruthy();
});

test('the log lists sent digests, and the mode saves', async () => {
  const saved = mount();
  expect(await screen.findByText(/Sent to the webhook/)).toBeTruthy();
  expect(screen.getByText('Behind pace')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Notify' }));
  expect(saved).toEqual([{ planning: { warnings: 'notify' } }]);
});
