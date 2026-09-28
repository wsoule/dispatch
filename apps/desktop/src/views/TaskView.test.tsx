import type { ApiClient, Message, RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import { dataWith } from '../components/settings/fixtures.test-helper';
import type { ShellActions } from '../components/shell/ShellActionsContext';
import { ShellActionsProvider } from '../components/shell/ShellActionsContext';
import { ToastProvider } from '../components/shell/Toasts';
import type { TaskDetailPanelProps } from '../components/tasks/detail';
import type { ImpactSubjectRef, TaskTab } from '../lib/appNav';

// The Diff tab reaches `PierreWorkerPool`, whose `?worker&url` import `bun test`
// cannot resolve; stubbed the way SettingsView.test.tsx does, before the import.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { TaskView } = await import('./TaskView');

const TASK_ID = 't-000001';
const doc: TaskDoc = {
  meta: {
    id: TASK_ID,
    title: 'Checkout',
    status: 'working',
    kind: 'task',
    priority: 'none',
    parent: null,
    milestone: null,
    labels: [],
    assignee: 'none',
    blockedBy: [],
    created: '2026-09-25T10:00:00.000Z',
    updated: '2026-09-25T10:00:00.000Z',
    external: null,
    selfReview: true,
    writes: [],
    risk: 'routine',
    model: null,
    exercised: false,
  },
  body: '',
};
const run = {
  id: 'r-000001',
  taskId: TASK_ID,
  taskTitle: 'Checkout',
  executor: 'claude',
  state: 'running',
  branch: 'dispatch/t-000001',
  baseBranch: 'main',
  worktreePath: '/wt/r-000001',
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
} as RunMeta;
// A run's note to its task, pointing at a task, a file, another message and a doc section.
const note: Message = {
  id: 'm-01',
  thread: 'm-01',
  replyTo: null,
  from: 'run:r-000001',
  to: [`task:${TASK_ID}`],
  kind: 'message',
  body: 'Moved the cart schema',
  refs: [
    { type: 'task', id: 't-000002' },
    { type: 'file', id: 'src/cart.ts' },
    { type: 'message', id: 'm-00' },
    { type: 'doc', id: 'doc-01K', at: 'api' },
  ],
  urgent: false,
  blocking: false,
  wake: 'none',
  createdAt: '2026-09-25T10:00:00.000Z',
};

function panelProps(): TaskDetailPanelProps {
  return {
    doc,
    statuses: ['draft', 'ready', 'working', 'review', 'landing', 'landed'],
    ready: false,
    run: undefined,
    runs: [run],
    epics: [],
    tasks: [doc],
    latestRunByTaskId: new Map(),
    onUpdate: () => Promise.resolve(),
    onMoveStatus: () => Promise.resolve(),
    onDispatch: () => Promise.resolve(),
    onOpenSession: () => {},
    linearLinks: {},
    linearConfigured: false,
    client: null,
    port: undefined,
    fixLoopEscalation: [],
  };
}

// Records where the shell and the page were asked to go.
function mountView(tab: TaskTab) {
  const went: string[] = [];
  const noop = () => {};
  const shell: ShellActions = {
    openTask: (taskId, taskTab, runId) =>
      went.push(['task', taskId, taskTab, runId].filter(Boolean).join(' ')),
    openThread: (messageId) => went.push(`thread ${messageId}`),
    peekTask: noop,
    openCreateTask: noop,
    createPreset: null,
    closeCreateTask: noop,
    openPalette: noop,
    toggleSidebar: noop,
    sidebarHidden: false,
    openOverseer: noop,
    setProjectView: noop,
    setGlobalView: noop,
    openShortcuts: noop,
    copyTaskId: noop,
  };
  const client = {
    listRecentThreads: () =>
      Promise.resolve({
        threads: [{ thread: 'm-01', root: note, last: note, count: 1 }],
      }),
    getMailbox: () => Promise.resolve({ items: [] }),
    openDecisions: () => Promise.resolve({ items: [] }),
    getMessage: () => Promise.resolve(note),
    getThread: () => Promise.resolve({ messages: [note], deliveries: [] }),
    markDeliveryRead: () => Promise.resolve({}),
    listChannels: () => Promise.resolve({ channels: [] }),
    listAgentRoster: () => Promise.resolve({ agents: [] }),
  };
  const data = dataWith({
    client: client as unknown as ApiClient,
    port: 4000,
    me: 'human:wyat',
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    tasks: [doc],
    tasksIncludingArchived: [doc],
    runs: [run],
    presence: [],
    readyIds: new Set(),
  });
  const tabs: TaskTab[] = [];
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToastProvider>
        <ShellActionsProvider value={shell}>
          <TaskView
            data={data}
            taskId={TASK_ID}
            tab={tab}
            activeRunId={null}
            onSetTab={(next) => tabs.push(next)}
            onSelectRun={noop}
            onBack={noop}
            panelProps={panelProps()}
            onViewPr={noop}
            onOpenImpact={(subject: ImpactSubjectRef) =>
              went.push(`impact ${subject.kind} ${subject.id}`)
            }
            onOpenDoc={(docId, anchor) => went.push(`doc ${docId} ${anchor}`)}
            projectName="storefront"
          />
        </ShellActionsProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { went, tabs };
}

test('the Thread tab sits between Chat and Diff and switches the page to it', () => {
  const { tabs } = mountView('details');
  const views = screen.getByRole('tablist', { name: 'Task views' });
  expect(
    within(views)
      .getAllByRole('tab')
      .map((t) => t.textContent)
  ).toEqual(['Details', 'Chat', 'Thread', 'Diff', 'Preview']);
  fireEvent.click(within(views).getByRole('tab', { name: 'Thread' }));
  expect(tabs).toEqual(['thread']);
});

// The session picker says which run Chat and Diff read; a thread is not one run's.
test('the Thread tab hides the session picker that Chat shows', () => {
  mountView('chat');
  expect(
    screen.getByRole('button', { name: 'Session' }).textContent
  ).toBeTruthy();
  cleanup();
  mountView('thread');
  expect(
    screen.queryByRole('button', { name: 'Session' })?.textContent
  ).toBeUndefined();
});

test("the Thread tab lists the task's threads, and a thread's links go where they point", async () => {
  const { went } = mountView('thread');
  const list = screen.getByRole('complementary', { name: 'Thread list' });
  fireEvent.click(
    await within(list).findByRole('option', { name: /Moved the cart schema/ })
  );
  const thread = screen.getByRole('region', { name: 'Thread' });
  fireEvent.click(await within(thread).findByText('task:t-000002'));
  fireEvent.click(within(thread).getByText('file:src/cart.ts'));
  fireEvent.click(within(thread).getByText('message:m-00'));
  fireEvent.click(within(thread).getByText('doc:doc-01K#api'));
  fireEvent.click(within(thread).getByRole('button', { name: /r-000001/ }));
  expect(went).toEqual([
    'task t-000002 details',
    'impact file src/cart.ts',
    'thread m-00',
    'doc doc-01K api',
    'task t-000001 chat r-000001',
  ]);
});
