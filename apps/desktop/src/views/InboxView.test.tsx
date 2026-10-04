import type { ApiClient, DocSummary, MemoryEntryView } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, expect, mock, test } from 'bun:test';
import { type ReactNode, useState } from 'react';

import {
  type NotificationInbox,
  NotificationInboxProvider,
} from '../components/shell/NotificationInboxContext';
import {
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { FeedRowModel } from '../lib/controlRoom';
import type { InboxEntry } from '../lib/inbox';
import type { InboxData } from '../lib/inboxQueue';
import { InboxView } from './InboxView';

// Read state persists in localStorage; start every test unread.
beforeEach(() => window.localStorage.clear());

/** A `DispatchProjectData` stub carrying only what InboxView reads — the
 *  daemon-availability fields plus the question/approval maps and merge actions. */
function projectWith(
  overrides: Partial<DispatchProjectData> = {}
): DispatchProjectData {
  return {
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {},
    runs: [],
    tasks: [],
    tasksIncludingArchived: [],
    retryEnsureDispatchd: () => {},
    openQuestions: new Map(),
    pendingApprovals: new Map(),
    pendingScopeRequests: new Map(),
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    handleRestartDaemon: async () => {},
    handleMergeAllReady: async () => {},
    handleEnqueueMerge: async () => {},
    handleAnswerQuestion: async () => {},
    handleApprove: async () => {},
    ...overrides,
  } as unknown as DispatchProjectData;
}

function row(over: Partial<FeedRowModel> = {}): FeedRowModel {
  return {
    runId: 'r-1',
    taskId: 't-1',
    title: 'Do the thing',
    state: 'review',
    epicTitle: null,
    priority: null,
    since: '2026-08-10T00:00:00.000Z',
    activity: null,
    attention: null,
    fixLoop: null,
    ...over,
  };
}

function dataWith(
  sections: InboxData['sections'],
  extra: Partial<InboxData> = {}
): InboxData {
  const readyToLand = extra.readyToLand ?? [];
  const prs = extra.prs ?? [];
  const total =
    sections.reduce((n, s) => n + s.rows.length, 0) +
    readyToLand.length +
    prs.length;
  return { sections, readyToLand, prs, total };
}

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: '2026-08-09T00:00:00.000Z:Run finished',
    ts: '2026-08-09T00:00:00.000Z',
    title: 'Run finished',
    body: 'Earlier task',
    target: { kind: 'run', runId: 'r-old' },
    read: false,
    ...over,
  };
}

interface Log {
  opened: string[];
  markAllRead: number;
  markedRead: string[];
  navigated: string[];
}

function providersWith(log: Log, entries: InboxEntry[] = []) {
  const noop = () => {};
  const shell = {
    openTask: (taskId: string) => log.opened.push(taskId),
    openThread: noop,
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
  } as unknown as ShellActions;
  // The task spec pane fetches its body through react-query; no retries in a stub.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Stateful like the real seam: mark-all flips every entry's own read flag, `markRead` one.
  return function Providers({ children }: { children: ReactNode }) {
    const [current, setCurrent] = useState(entries);
    const inbox: NotificationInbox = {
      entries: current,
      unreadCount: current.filter((e) => !e.read).length,
      markAllRead: () => {
        log.markAllRead += 1;
        setCurrent((prev) => prev.map((e) => ({ ...e, read: true })));
      },
      markRead: (id) => {
        log.markedRead.push(id);
        setCurrent((prev) =>
          prev.map((e) => (e.id === id ? { ...e, read: true } : e))
        );
      },
      navigate: (target) => log.navigated.push(target.kind),
    };
    return (
      <QueryClientProvider client={queryClient}>
        <ShellActionsProvider value={shell}>
          <NotificationInboxProvider value={inbox}>
            {children}
          </NotificationInboxProvider>
        </ShellActionsProvider>
      </QueryClientProvider>
    );
  };
}

const ROOT = '/tmp/dispatch';
const READ_KEY = `dispatch:inbox-read:${ROOT}`;

function renderInbox(
  data: InboxData,
  {
    project = projectWith(),
    entries = [],
    onOpenPr = () => {},
    onOpenDoc,
    projectRoot = ROOT,
  }: {
    project?: DispatchProjectData;
    entries?: InboxEntry[];
    onOpenPr?: (n: number) => void;
    onOpenDoc?: (id: string) => void;
    projectRoot?: string | null;
  } = {}
) {
  const log: Log = {
    opened: [],
    markAllRead: 0,
    markedRead: [],
    navigated: [],
  };
  const Providers = providersWith(log, entries);
  const result = render(
    <Providers>
      <InboxView
        data={data}
        project={project}
        projectName="dispatch"
        projectRoot={projectRoot}
        onOpenPr={onOpenPr}
        onOpenDoc={onOpenDoc}
      />
    </Providers>
  );
  return { ...result, log };
}

const rows = () => screen.getAllByRole('option');
// Scoped to the list: the selected item's title repeats in the right pane's header.
const rowOf = (title: string) => {
  const el = within(screen.getByRole('listbox'))
    .getByText(title)
    .closest('[role="option"]');
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return el;
};

test('two panes: a 348px list under the crumb header and an empty right pane counting unread', () => {
  const { container } = renderInbox(
    dataWith([
      {
        state: 'answer',
        rows: [row({ taskId: 't-a', runId: 'r-a', state: 'answer' })],
      },
      { state: 'review', rows: [row({ taskId: 't-b', runId: 'r-b' })] },
    ]),
    { entries: [entry({ read: true })] }
  );

  const header = container.querySelector('[data-slot="page-header"]');
  expect(header?.textContent).toContain('dispatch');
  expect(header?.textContent).toContain('Inbox');
  const grid = container.querySelector(
    '.grid-cols-\\[348px_minmax\\(0\\,1fr\\)\\]'
  );
  expect(grid).not.toBeNull();
  expect(
    container.querySelector('[data-slot="inbox-list-pane"]')
  ).not.toBeNull();
  const detail = container.querySelector('[data-slot="inbox-detail-pane"]');
  // Two live rows unread, one notification already read.
  expect(detail?.textContent).toContain('2 unread');
  // The list pane header names itself and carries the three round icons.
  expect(
    screen.getByRole('button', { name: 'Mark all as read' })
  ).toBeDefined();
  expect(screen.getByRole('button', { name: 'Filter' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Display' })).toBeDefined();
});

test('rows are 48px with an avatar badge, an unread dot, and the glyph over the time', () => {
  renderInbox(
    dataWith([
      {
        state: 'approve',
        rows: [
          row({
            taskId: 't-a',
            runId: 'r-a',
            state: 'approve',
            title: 'Needs a hand',
            attention: { reason: 'Wants to run Bash', detail: null },
          }),
        ],
      },
    ]),
    { entries: [entry({ read: true })] }
  );

  const live = rowOf('Needs a hand');
  expect(live.className).toContain('h-12');
  expect(live.querySelector('[data-slot="initials-avatar"]')).not.toBeNull();
  expect(live.querySelector('[data-slot="inbox-badge"]')).not.toBeNull();
  expect(live.querySelector('[data-slot="unread-dot"]')).not.toBeNull();
  expect(live.textContent).toContain('t-a');
  expect(live.textContent).toContain('Approve · Wants to run Bash');
  // Unread: bright title.
  expect(live.querySelector('[data-slot="inbox-title"]')?.className).toContain(
    'text-foreground'
  );

  // Read: muted title, no dot.
  const read = rowOf('Run finished');
  expect(read.querySelector('[data-slot="unread-dot"]')).toBeNull();
  expect(read.querySelector('[data-slot="inbox-title"]')?.className).toContain(
    'text-muted-foreground'
  );
});

test('selecting a row marks it read and shows it on the right; mark-all clears the rest', () => {
  const { container, log } = renderInbox(
    dataWith([
      {
        state: 'review',
        rows: [
          row({ taskId: 't-b', runId: 'r-b', title: 'First' }),
          row({ taskId: 't-c', runId: 'r-c', title: 'Second' }),
        ],
      },
    ]),
    { entries: [entry()] }
  );

  fireEvent.click(rowOf('First'));
  const first = rowOf('First');
  expect(first.getAttribute('aria-selected')).toBe('true');
  // Selection is the neutral selected surface, never the accent.
  expect(first.className).toContain('bg-surface-selected');
  expect(first.querySelector('[data-slot="unread-dot"]')).toBeNull();
  expect(
    rowOf('Second').querySelector('[data-slot="unread-dot"]')
  ).not.toBeNull();

  const detail = container.querySelector('[data-slot="inbox-detail-pane"]');
  expect(detail?.textContent).toContain('First');
  expect(
    within(detail as HTMLElement).getByRole('button', { name: 'Open' })
  ).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
  expect(log.markAllRead).toBe(1);
  expect(container.querySelectorAll('[data-slot="unread-dot"]')).toHaveLength(
    0
  );
});

test('j/k move the selection and Enter opens the selected task', () => {
  const { log } = renderInbox(
    dataWith([
      {
        state: 'review',
        rows: [
          row({ taskId: 't-b', runId: 'r-b', title: 'First' }),
          row({ taskId: 't-c', runId: 'r-c', title: 'Second' }),
        ],
      },
    ])
  );
  const list = screen.getByRole('listbox');
  expect(list.getAttribute('aria-activedescendant')).toBeNull();
  fireEvent.keyDown(list, { key: 'j' });
  expect(rowOf('First').getAttribute('aria-selected')).toBe('true');
  // AT learns where j/k landed through the listbox's active descendant.
  expect(list.getAttribute('aria-activedescendant')).toBe(rowOf('First').id);
  fireEvent.keyDown(list, { key: 'j' });
  expect(rowOf('Second').getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(list, { key: 'k' });
  expect(rowOf('First').getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(list, { key: 'Enter' });
  expect(log.opened).toEqual(['t-b']);
});

test('Enter on a clicked (focused) row opens it exactly once', () => {
  const { log } = renderInbox(
    dataWith([{ state: 'review', rows: [row({ title: 'Only' })] }])
  );
  const target = rowOf('Only');
  fireEvent.click(target);
  fireEvent.keyDown(target, { key: 'Enter' });
  expect(log.opened).toEqual(['t-1']);
});

test('selecting a notification row reads it: dot gone, seam told', () => {
  const { log } = renderInbox(dataWith([]), {
    entries: [entry({ id: 'n-1', title: 'Merged', target: { kind: 'queue' } })],
  });
  expect(
    rowOf('Merged').querySelector('[data-slot="unread-dot"]')
  ).not.toBeNull();
  fireEvent.click(rowOf('Merged'));
  expect(rowOf('Merged').querySelector('[data-slot="unread-dot"]')).toBeNull();
  expect(
    rowOf('Merged').querySelector('[data-slot="inbox-title"]')?.className
  ).toContain('text-muted-foreground');
  expect(log.markedRead).toEqual(['n-1']);
});

// Read state persists per project, pruned to the rows on screen — so it must not be written
// from the empty list the daemon has not answered yet, nor from a set loaded for another root.
test('read state is not persisted while the daemon is still loading', () => {
  window.localStorage.setItem(READ_KEY, JSON.stringify(['review:t-1:r-1']));
  renderInbox(dataWith([]), { project: projectWith({ portLoading: true }) });
  expect(window.localStorage.getItem(READ_KEY)).toBe(
    JSON.stringify(['review:t-1:r-1'])
  );
});

test('read state persists once the rows are live, and only for the given root', () => {
  window.localStorage.setItem(READ_KEY, JSON.stringify(['review:t-1:r-1']));
  const { rerender } = renderInbox(
    dataWith([{ state: 'review', rows: [row({ title: 'Seen before' })] }])
  );
  // Loaded from storage: the stored key renders read.
  expect(
    rowOf('Seen before').querySelector('[data-slot="unread-dot"]')
  ).toBeNull();

  // Another project mounts over it: its own (empty) set loads, and the first project's
  // stored set survives untouched.
  const Providers = providersWith(
    { opened: [], markAllRead: 0, markedRead: [], navigated: [] },
    []
  );
  rerender(
    <Providers>
      <InboxView
        data={dataWith([{ state: 'review', rows: [row({ title: 'Other' })] }])}
        project={projectWith()}
        projectName="other"
        projectRoot="/tmp/other"
        onOpenPr={() => {}}
      />
    </Providers>
  );
  expect(window.localStorage.getItem(READ_KEY)).toBe(
    JSON.stringify(['review:t-1:r-1'])
  );
  expect(
    rowOf('Other').querySelector('[data-slot="unread-dot"]')
  ).not.toBeNull();
});

test('without a project root, read state stays in memory only', () => {
  renderInbox(
    dataWith([{ state: 'review', rows: [row({ title: 'Ephemeral' })] }]),
    { projectRoot: null }
  );
  fireEvent.click(rowOf('Ephemeral'));
  expect(
    rowOf('Ephemeral').querySelector('[data-slot="unread-dot"]')
  ).toBeNull();
  expect(window.localStorage.length).toBe(0);
});

test('the Open pill opens the selected task through the shell', () => {
  const { container, log } = renderInbox(
    dataWith([{ state: 'review', rows: [row({ title: 'Reviewable' })] }])
  );
  fireEvent.click(rowOf('Reviewable'));
  const detail = container.querySelector('[data-slot="inbox-detail-pane"]');
  fireEvent.click(
    within(detail as HTMLElement).getByRole('button', { name: 'Open' })
  );
  expect(log.opened).toEqual(['t-1']);
});

test('an answer row shows its question card with the indigo Answer button on the right', () => {
  const answers: string[] = [];
  renderInbox(
    dataWith([
      {
        state: 'answer',
        rows: [
          row({ taskId: 't-a', runId: 'r-a', state: 'answer', title: 'Asks' }),
        ],
      },
    ]),
    {
      project: projectWith({
        openQuestions: new Map([
          [
            'r-a',
            [
              {
                id: 'q-1',
                runId: 'r-a',
                question: 'Which way?',
                options: ['Left', 'Right'],
                askedAt: '2026-08-10T00:00:00.000Z',
                answer: null,
              },
            ],
          ],
        ]),
        handleAnswerQuestion: (_run: string, _q: string, a: string) => {
          answers.push(a);
          return Promise.resolve();
        },
      } as unknown as Partial<DispatchProjectData>),
    }
  );
  fireEvent.click(rowOf('Asks'));
  expect(screen.getByText('Which way?')).toBeDefined();
  fireEvent.click(screen.getByRole('radio', { name: 'Left' }));
  expect(answers).toEqual(['Left']);
  expect(screen.getByRole('button', { name: 'Answer' })).toBeDefined();
});

// An ended run's scope gate stays open for its task, so its row still decides it.
test('an answer row with an open scope gate shows the scope card', async () => {
  const decided: string[] = [];
  renderInbox(
    dataWith([
      {
        state: 'answer',
        rows: [
          row({ taskId: 't-a', runId: 'r-a', state: 'answer', title: 'Fence' }),
        ],
      },
    ]),
    {
      project: projectWith({
        pendingScopeRequests: new Map([
          [
            'r-a',
            {
              id: 'm-s',
              runId: 'r-a',
              paths: ['src/payments/cart.ts'],
              reason: 'the cart lives there',
              requestedAt: '2026-08-10T00:00:00.000Z',
              granted: null,
              decisionReason: null,
              decidedAt: null,
              decidedBy: null,
            },
          ],
        ]),
        handleDecideScopeRequest: (
          runId: string,
          requestId: string,
          granted: boolean
        ) => {
          decided.push(`${runId}:${requestId}:${granted}`);
          return Promise.resolve();
        },
      } as unknown as Partial<DispatchProjectData>),
    }
  );
  fireEvent.click(rowOf('Fence'));
  expect(screen.getByText('src/payments/cart.ts')).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: /Deny/ }));
    await Promise.resolve();
  });
  expect(decided).toEqual(['r-a:m-s:false']);
});

// Each parked call is its own gate, so the detail pane shows one card per call.
test('an approve row shows a card per parked call, each answering its own', async () => {
  const answered: string[] = [];
  const { container } = renderInbox(
    dataWith([
      {
        state: 'approve',
        rows: [
          row({
            taskId: 't-a',
            runId: 'r-a',
            state: 'approve',
            title: 'Parks',
          }),
        ],
      },
    ]),
    {
      project: projectWith({
        pendingApprovals: new Map([
          [
            'r-a',
            [
              {
                requestId: 'req-1',
                toolName: 'Bash',
                input: { command: 'ls' },
                truncated: false,
              },
              {
                requestId: 'req-2',
                toolName: 'Write',
                input: { file_path: 'a.ts' },
                truncated: false,
              },
            ],
          ],
        ]),
        handleApprove: (_run: string, requestId: string) => {
          answered.push(requestId);
          return Promise.resolve();
        },
      } as unknown as Partial<DispatchProjectData>),
    }
  );
  fireEvent.click(rowOf('Parks'));
  const cards = container.querySelectorAll('[data-slot="tool-approval-card"]');
  expect(cards).toHaveLength(2);
  await act(async () => {
    fireEvent.click(
      within(cards[0] as HTMLElement).getByRole('radio', {
        name: /Approve once/,
      })
    );
    await Promise.resolve();
  });
  expect(answered).toEqual(['req-1']);
});

function liveAndPast() {
  return renderInbox(
    dataWith([{ state: 'review', rows: [row({ title: 'Live' })] }]),
    { entries: [entry({ body: 'Past' })] }
  );
}

test('the filter narrows to what needs you', async () => {
  liveAndPast();
  expect(rows()).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  fireEvent.click(
    await screen.findByRole('menuitemradio', { name: 'Needs you' })
  );
  expect(rows()).toHaveLength(1);
  expect(rowOf('Live')).toBeDefined();
});

test('the filter narrows to what already happened', async () => {
  liveAndPast();
  fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  fireEvent.click(
    await screen.findByRole('menuitemradio', { name: 'Earlier' })
  );
  expect(rows()).toHaveLength(1);
  expect(rowOf('Run finished')).toBeDefined();
});

test('display groups the list by kind under group headers', async () => {
  liveAndPast();
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.click(
    await screen.findByRole('menuitemcheckbox', { name: 'Group by kind' })
  );
  const headers = document.querySelectorAll('[data-slot="group-header"]');
  expect(Array.from(headers, (h) => h.textContent)).toEqual([
    'Review1',
    'Earlier1',
  ]);
  // A state-backed group carries the Control room's status tint; the record group does not.
  expect((headers[0] as HTMLElement).className).toContain('status-tint');
  expect((headers[1] as HTMLElement).className).not.toContain('status-tint');
  expect(screen.getByRole('group', { name: 'Review' })).toBeDefined();
});

// The merge affordances: the header ghost queues everything ready; each review row can
// queue just itself — without navigating.
test('queue-merge affordances call the queue, not navigation', () => {
  const calls: string[] = [];
  let mergeAll = 0;
  const { log } = renderInbox(
    dataWith([
      {
        state: 'review',
        rows: [
          row({ title: 'Ready to land' }),
          row({ taskId: 't-2', runId: 'r-2', title: 'Also ready' }),
        ],
      },
    ]),
    {
      project: projectWith({
        handleMergeAllReady: () => {
          mergeAll += 1;
          return Promise.resolve();
        },
        handleEnqueueMerge: (runId: string) => {
          calls.push(runId);
          return Promise.resolve();
        },
      } as unknown as Partial<DispatchProjectData>),
    }
  );

  fireEvent.click(screen.getByRole('button', { name: /queue all for merge/i }));
  expect(mergeAll).toBe(1);

  fireEvent.click(
    screen.getByRole('button', { name: 'Queue merge: Ready to land' })
  );
  expect(calls).toEqual(['r-1']);
  expect(log.opened).toEqual([]);
});

test('an unclaimed PR renders with its number and Open goes to the PR page', () => {
  const opened: number[] = [];
  const { container } = renderInbox(
    dataWith([], {
      prs: [
        {
          number: 9,
          url: 'https://github.com/x/y/pull/9',
          title: 'Standalone PR',
          author: 'octocat',
          headRefName: 'feat',
          baseRefName: 'main',
          isDraft: false,
          updatedAt: '2026-08-10T00:00:00.000Z',
        } as InboxData['prs'][number],
      ],
    }),
    { onOpenPr: (n) => opened.push(n) }
  );
  const pr = rowOf('Standalone PR');
  expect(pr.textContent).toContain('#9');
  fireEvent.click(pr);
  const detail = container.querySelector('[data-slot="inbox-detail-pane"]');
  expect(detail?.textContent).toContain('by octocat');
  fireEvent.click(
    within(detail as HTMLElement).getByRole('button', { name: 'Open' })
  );
  expect(opened).toEqual([9]);
});

test('a notification row opens through the inbox seam', () => {
  const { container, log } = renderInbox(dataWith([]), {
    entries: [entry({ title: 'Merged', target: { kind: 'queue' } })],
  });
  fireEvent.click(rowOf('Merged'));
  const detail = container.querySelector('[data-slot="inbox-detail-pane"]');
  fireEvent.click(
    within(detail as HTMLElement).getByRole('button', { name: 'Open' })
  );
  expect(log.navigated).toEqual(['queue']);
});

// A review row whose run the merge queue bounced says so on the row itself, so the
// review list and the Landing table's "Failed to land" agree. Latest attempt wins — a
// failure followed by a merge is not news — and a run back in the queue is the queue's
// to report, not the pill's.
test('a review row whose latest queue attempt failed carries a Failed to land pill', () => {
  const attempt = (
    runId: string,
    state: 'queued' | 'merged' | 'failed',
    reason?: string
  ) => ({
    runId,
    taskId: `t-${runId}`,
    taskTitle: runId,
    state,
    reason,
    enqueuedAt: '2026-08-10T00:00:00.000Z',
    finishedAt: state === 'queued' ? undefined : '2026-08-10T00:05:00.000Z',
  });

  renderInbox(
    dataWith([
      {
        state: 'review',
        rows: [
          row({ taskId: 't-bounced', runId: 'bounced', title: 'Bounced' }),
          row({ taskId: 't-healed', runId: 'healed', title: 'Healed' }),
          row({ taskId: 't-requeued', runId: 'requeued', title: 'Requeued' }),
          row({ taskId: 't-fine', runId: 'fine', title: 'Never queued' }),
        ],
      },
    ]),
    {
      project: projectWith({
        mergeQueue: {
          entries: [attempt('requeued', 'queued')],
          // Most-recent-first, as the server sends it.
          history: [
            attempt('bounced', 'failed', 'verify failed: tests exited 1'),
            attempt('healed', 'merged'),
            attempt('healed', 'failed', 'flake'),
            attempt('requeued', 'failed', 'flake'),
          ],
        },
      } as unknown as Partial<DispatchProjectData>),
    }
  );

  const pills = screen.getAllByText('Failed to land');
  expect(pills).toHaveLength(1);
  expect(pills[0]?.closest('[role="option"]')?.textContent).toContain(
    'Bounced'
  );
  // The reason rides on the pill for hover, not in the row text.
  expect(
    pills[0]?.closest('[data-slot="label-pill"]')?.getAttribute('title')
  ).toBe('verify failed: tests exited 1');
});

// Personal memory writes are listed only here, from the caller's own activity.
test('lists your memory activity under Your memory, each with its Undo', async () => {
  const undoMemory = mock((_ref: string) =>
    Promise.resolve({} as MemoryEntryView)
  );
  const project = projectWith({
    port: 4321,
    client: {
      memoryActivity: () =>
        Promise.resolve({
          activity: [
            {
              id: 'ma-1',
              at: '2026-09-25T10:00:00.000Z',
              kind: 'saved',
              memoryId: 'mem-1',
              runId: 'r-9f2c01',
              summary: 'run:r-9f2c01 saved to your memory: pnpm builds',
            },
          ],
        }),
      undoMemory,
    } as unknown as ApiClient,
  });
  renderInbox(dataWith([]), { project });
  const section = await screen.findByRole('region', { name: 'Your memory' });
  expect(
    within(section).getByText('run:r-9f2c01 saved to your memory: pnpm builds')
  ).toBeTruthy();
  fireEvent.click(within(section).getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(undoMemory).toHaveBeenCalledWith('mem-1'));
});

// The list covers the last day; the CLI reverts an older entry's latest change.
test('says the list covers the last day and how to undo an entry changed earlier', async () => {
  const project = projectWith({
    port: 4321,
    client: {
      memoryActivity: () =>
        Promise.resolve({
          activity: [
            {
              id: 'ma-1',
              at: '2026-09-25T10:00:00.000Z',
              kind: 'saved',
              memoryId: 'mem-1',
              runId: 'r-9f2c01',
              summary: 'run:r-9f2c01 saved to your memory: pnpm builds',
            },
          ],
        }),
    } as unknown as ApiClient,
  });
  renderInbox(dataWith([]), { project });
  const section = await screen.findByRole('region', { name: 'Your memory' });
  expect(within(section).getByText(/last day/).textContent).toContain(
    'Undo reverts an entry’s latest change'
  );
  expect(
    within(section).getByText('dispatch memory undo <handle>')
  ).toBeTruthy();
  expect(
    within(section).getByText(
      'dispatch memory list --scope personal --state all'
    )
  ).toBeTruthy();
});

test('has no memory section while nothing was written to your memory', async () => {
  const memoryActivity = mock(() => Promise.resolve({ activity: [] }));
  renderInbox(dataWith([]), {
    project: projectWith({
      port: 4321,
      client: { memoryActivity } as unknown as ApiClient,
    }),
  });
  await waitFor(() => expect(memoryActivity).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: 'Your memory' })).toBeNull();
});

const conflicted = (over: Record<string, unknown> = {}) =>
  ({
    id: 'doc-1',
    handle: 'auth',
    title: 'Auth refactor',
    scope: 'team',
    conflicted: true,
    updatedAt: '2026-09-26T10:00:00.000Z',
    ...over,
  }) as unknown as DocSummary;

test('a conflicted doc renders as a row and Open doc opens it', () => {
  const opened: string[] = [];
  const { container } = renderInbox(
    { ...dataWith([]), docs: [conflicted()], total: 1 },
    { onOpenDoc: (id) => opened.push(id) }
  );
  fireEvent.click(rowOf('Conflict markers in Auth refactor'));
  const detail = container.querySelector('[data-slot="inbox-detail-pane"]');
  fireEvent.click(
    within(detail as HTMLElement).getByRole('button', { name: 'Open doc' })
  );
  expect(opened).toEqual(['doc-1']);
});
