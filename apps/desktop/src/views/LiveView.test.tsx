import type { EpicProgress, RunMeta } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import { progress, run, task } from '../components/live/fixtures.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskAttention } from '../lib/taskAttention';

// The side pane mounts the task page, whose Review mode pulls in the Pierre diff; its
// worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { LiveView } = await import('./LiveView');

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

// Checkout fans out (active): a landed, b has an agent, c waits on b, d is ready, e is
// Maya's. Search's fan-out is paused. Billing has a run waiting on a review. l-1 runs
// with no container.
const TASKS: TaskListItem[] = [
  task('m-1', { kind: 'milestone', title: 'Checkout' }),
  task('t-a', { parent: 'm-1', status: 'landed' }),
  task('t-b', { parent: 'm-1', status: 'working' }),
  task('t-c', { parent: 'm-1', blockedBy: ['t-b'] }),
  task('t-d', { parent: 'm-1' }),
  task('t-e', { parent: 'm-1', assignee: 'human:maya' }),
  task('m-2', { kind: 'milestone', title: 'Search' }),
  task('u-a', { parent: 'm-2' }),
  task('u-b', { parent: 'm-2' }),
  task('m-3', { kind: 'milestone', title: 'Billing' }),
  task('v-a', { parent: 'm-3', status: 'review' }),
  task('v-b', { parent: 'm-3' }),
  task('l-1', { status: 'working', title: 'Loose one' }),
];

const RUNS: RunMeta[] = [
  run('t-b', { costUsd: 0.4 }),
  run('l-1'),
  run('v-a', { state: 'finished', costUsd: 1.1 }),
];

interface Handlers {
  paused: string[];
  resumed: string[];
}

function dataWith(
  opts: {
    tasks?: TaskListItem[];
    runs?: RunMeta[];
    sessions?: EpicProgress[];
    attention?: [string, TaskAttention][];
    readyIds?: string[];
  } = {},
  handlers: Handlers = { paused: [], resumed: [] }
): DispatchProjectData {
  const tasks = opts.tasks ?? TASKS;
  const runs = opts.runs ?? RUNS;
  const sessions = opts.sessions ?? [
    progress('m-1', 'active', { concurrency: 2 }),
    progress('m-2', 'paused', { pausedReason: 'human' }),
  ];
  return {
    client: {},
    port: 1,
    portLoading: false,
    portError: false,
    config: null,
    me: 'human:wyat',
    localHuman: 'human:wyat',
    people: [],
    tasks,
    tasksIncludingArchived: tasks,
    tasksReady: true,
    runs,
    latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
    liveRunStateByTaskId: new Map(
      runs.filter((r) => r.state === 'running').map((r) => [r.taskId, r.state])
    ),
    attentionByTaskId: new Map(opts.attention ?? [['v-a', 'review']]),
    epicProgressById: new Map(sessions.map((p) => [p.epicId, p])),
    liveEpicSessions: sessions,
    mergeQueue: null,
    readyIds: new Set(opts.readyIds ?? []),
    linearLinks: {},
    handlePauseEpic: (id: string) => {
      handlers.paused.push(id);
      return Promise.resolve();
    },
    handleResumeEpic: (id: string) => {
      handlers.resumed.push(id);
      return Promise.resolve();
    },
    handleStopEpic: () => Promise.resolve(),
    handleLandEpic: () => Promise.resolve(),
    handleWorkEpic: () => Promise.resolve(),
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

function mount(
  data: DispatchProjectData,
  dispatchTask: (taskId: string) => Promise<void> = () => Promise.resolve()
) {
  const calls = { opened: [] as string[], peeked: [] as string[] };
  const view = (d: DispatchProjectData) => (
    <LiveView
      data={d}
      projectName="demo"
      dispatchTask={dispatchTask}
      onDispatchFailed={() => {}}
      onOpenTask={(id, tab) =>
        calls.opened.push(tab === undefined ? id : `${id}:${tab}`)
      }
      onPeekTask={(id) => calls.peeked.push(id)}
    />
  );
  const result = render(view(data));
  return {
    ...result,
    calls,
    rerenderWith: (d: DispatchProjectData) => result.rerender(view(d)),
  };
}

const bands = () =>
  Array.from(document.querySelectorAll('[data-slot=live-band]')).map((b) =>
    b.getAttribute('data-live-band')
  );
const node = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-slot=flight-node][data-node-id="${id}"]`
  );
const group = () => screen.getByRole('group', { name: 'Live work' });
const press = (key: string) => fireEvent.keyDown(group(), { key });
const cursor = () => group().getAttribute('aria-activedescendant');

describe('LiveView', () => {
  test('draws a band per container in motion, running first, then paused, then the rest', () => {
    mount(dataWith());
    expect(bands()).toEqual(['m-1', '__loose', 'm-2', 'm-3']);
    expect(
      Array.from(
        document.querySelectorAll('[data-slot=live-band-title]'),
        (t) => t.textContent
      )
    ).toEqual(['Checkout', 'Loose work', 'Search', 'Billing']);
    expect(
      ['t-a', 't-b', 't-c', 't-d', 't-e'].map((id) =>
        node(id)?.getAttribute('data-state')
      )
    ).toEqual(['done', 'running', 'blocked', 'queued', 'teammate']);
    expect(node('t-c')?.textContent).toContain('Auto-starts when t-b finishes');
    expect(node('t-e')?.textContent).toContain('won’t auto-start');
    expect(node('l-1')?.getAttribute('data-state')).toBe('running');
  });

  test('the header adds every band up', () => {
    mount(
      dataWith({
        sessions: [
          progress('m-1', 'active', { concurrency: 2, maxSpendUsd: 20 }, 4),
          progress('m-2', 'paused', { pausedReason: 'human' }),
        ],
      })
    );
    const text = (slot: string) =>
      document.querySelector(`[data-slot=${slot}]`)?.textContent;
    expect(
      document
        .querySelector('[data-slot=live-slots]')
        ?.getAttribute('aria-label')
    ).toBe('1 of 4 slots in use');
    expect(text('live-running')).toBe('2running');
    expect(text('live-queued')).toBe('1queued');
    expect(text('live-teammate')).toBe('0waiting on teammates');
    expect(text('live-spend')).toBe('$4 of $20 ceilings');
  });

  test('j/k walk the nodes band after band, J/K jump a band', () => {
    mount(dataWith());
    act(() => group().focus());
    // Focus marks the first node; j moves from it in reading order.
    expect(cursor()).toBe('flight-node-t-a');
    press('j');
    expect(cursor()).toBe('flight-node-t-b');
    press('J');
    expect(cursor()).toBe('flight-node-l-1');
    press('J');
    expect(cursor()).toBe('flight-node-u-a');
    press('k');
    expect(cursor()).toBe('flight-node-l-1');
    press('K');
    expect(cursor()).toBe('flight-node-t-a');
    expect(node('t-a')?.hasAttribute('data-focused')).toBe(true);
  });

  test('d dispatches a node that may start, never a teammate’s', () => {
    const sent: string[] = [];
    mount(dataWith(), (id) => {
      sent.push(id);
      return new Promise(() => {});
    });
    act(() => group().focus());
    // t-a → t-b → t-d → t-e in reading order (wave 1, top to bottom).
    press('j');
    press('j');
    expect(cursor()).toBe('flight-node-t-d');
    press('d');
    expect(sent).toEqual(['t-d']);
    // Optimistic: the node flips to running at once.
    expect(node('t-d')?.getAttribute('data-state')).toBe('running');
    press('j');
    expect(cursor()).toBe('flight-node-t-e');
    press('d');
    expect(sent).toEqual(['t-d']);
  });

  describe('in a fan-out a teammate started', () => {
    // Maya started m-1's; this window is Wyat's. t-x is Maya's, t-y Wyat's, t-z waits
    // on t-y.
    const tasks = [
      task('m-1', { kind: 'milestone', title: 'Checkout' }),
      task('t-x', {
        parent: 'm-1',
        assignee: 'human:maya',
        created: '2026-09-01T00:00:01.000Z',
      }),
      task('t-y', {
        parent: 'm-1',
        assignee: 'human:wyat',
        created: '2026-09-01T00:00:02.000Z',
      }),
      task('t-z', {
        parent: 'm-1',
        blockedBy: ['t-y'],
        created: '2026-09-01T00:00:03.000Z',
      }),
    ];
    const mayas = () =>
      dataWith({
        tasks,
        runs: [],
        attention: [],
        sessions: [
          progress('m-1', 'active', {
            startedBy: 'human:maya',
            concurrency: 2,
          }),
        ],
      });

    test('d sends an agent at my own task, never at Maya’s', () => {
      const sent: string[] = [];
      mount(mayas(), (id) => {
        sent.push(id);
        return new Promise(() => {});
      });
      act(() => group().focus());
      expect(cursor()).toBe('flight-node-t-x');
      press('d');
      expect(sent).toEqual([]);
      press('j');
      expect(cursor()).toBe('flight-node-t-y');
      // Maya's fan-out never starts it, but I may by hand.
      expect(node('t-y')?.getAttribute('data-state')).toBe('teammate');
      press('d');
      expect(sent).toEqual(['t-y']);
    });

    test('work waiting on my own task is not waiting on a teammate', () => {
      mount(mayas());
      expect(node('t-z')?.getAttribute('data-state')).toBe('blocked');
      expect(
        document.querySelector('[data-slot=live-teammate]')?.textContent
      ).toBe('0waiting on teammates');
    });
  });

  test('Enter opens the task beside the bands, o its page, Space peeks', () => {
    const view = mount(dataWith());
    act(() => group().focus());
    press('Enter');
    expect(document.querySelector('[data-slot=task-pane]')).not.toBeNull();
    press('o');
    press(' ');
    expect(view.calls.opened).toEqual(['t-a']);
    expect(view.calls.peeked).toEqual(['t-a']);
    press('Escape');
    expect(document.querySelector('[data-slot=task-pane]')).toBeNull();
  });

  describe('the side pane', () => {
    const paneTask = () =>
      document
        .querySelector('[data-slot=task-pane]')
        ?.getAttribute('data-task-id') ?? null;
    const rest = () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, 300));
      });
    const click = (id: string) => act(() => node(id)?.click());

    test('follows the cursor once it rests', async () => {
      mount(dataWith());
      act(() => group().focus());
      press('Enter');
      expect(paneTask()).toBe('t-a');
      press('j');
      await rest();
      expect(paneTask()).toBe('t-b');
    });

    test('stays on its task when that task’s Loose run finishes', async () => {
      const view = mount(dataWith());
      click('l-1');
      expect(paneTask()).toBe('l-1');
      // A finished run waiting on a review is not Loose work, so l-1 leaves the view.
      view.rerenderWith(
        dataWith({
          tasks: TASKS.map((t) =>
            t.meta.id === 'l-1'
              ? { ...t, meta: { ...t.meta, status: 'review' } }
              : t
          ),
          runs: [run('t-b'), run('l-1', { state: 'finished' })],
          attention: [
            ['v-a', 'review'],
            ['l-1', 'review'],
          ],
        })
      );
      expect(node('l-1')).toBeNull();
      await rest();
      expect(paneTask()).toBe('l-1');
    });

    test('stays on its task when its wave lands and folds', async () => {
      const tasks = [
        task('m-1', { kind: 'milestone', title: 'Checkout' }),
        task('t-a', { parent: 'm-1', status: 'working' }),
        task('t-b', { parent: 'm-1', blockedBy: ['t-a'] }),
      ];
      const sessions = [progress('m-1', 'active')];
      const view = mount(
        dataWith({ tasks, runs: [run('t-a')], sessions, attention: [] })
      );
      click('t-a');
      expect(paneTask()).toBe('t-a');
      view.rerenderWith(
        dataWith({
          tasks: tasks.map((t) =>
            t.meta.id === 't-a'
              ? { ...t, meta: { ...t.meta, status: 'landed' } }
              : t
          ),
          runs: [
            run('t-a', {
              state: 'finished',
              reviewedAt: '2026-09-20T01:00:00.000Z',
            }),
          ],
          sessions,
          attention: [],
        })
      );
      expect(node('t-a')).toBeNull();
      await rest();
      expect(paneTask()).toBe('t-a');
    });
  });

  test('a band links to its full Flight Plan', () => {
    const view = mount(dataWith());
    const open = document.querySelector<HTMLElement>(
      '[data-live-band=m-1] [data-slot=live-band-open-plan]'
    );
    act(() => open?.click());
    expect(view.calls.opened).toEqual(['m-1:plan']);
  });

  test('Pause all asks first, then pauses every active fan-out', async () => {
    const handlers = { paused: [] as string[], resumed: [] as string[] };
    mount(dataWith({}, handlers));
    act(() =>
      document.querySelector<HTMLElement>('[data-slot=live-pause-all]')?.click()
    );
    expect(handlers.paused).toEqual([]);
    await screen.findByText('Pause the fan-out?');
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-slot=live-pause-all-confirm]')
        ?.click();
      await Promise.resolve();
    });
    // Only the active one: Search is already paused.
    expect(handlers.paused).toEqual(['m-1']);
  });

  test('with nothing filling slots, Resume all restarts what someone paused', async () => {
    const handlers = { paused: [] as string[], resumed: [] as string[] };
    mount(
      dataWith(
        {
          sessions: [
            progress('m-1', 'paused', { pausedReason: 'human' }),
            // A ceiling stopped Search: only a raised ceiling resumes it.
            progress('m-2', 'paused', { pausedReason: 'budget' }),
          ],
        },
        handlers
      )
    );
    expect(document.querySelector('[data-slot=live-pause-all]')).toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-slot=live-resume-all]')
        ?.click();
      await Promise.resolve();
    });
    expect(handlers.resumed).toEqual(['m-1']);
  });

  test('Resume all retries a fan-out whose auto-dispatch failed; only ceilings stay capped', async () => {
    const handlers = { paused: [] as string[], resumed: [] as string[] };
    mount(
      dataWith(
        {
          sessions: [
            // The daemon's own word for this pause: "Resume to try again".
            progress('m-1', 'paused', {
              pausedReason: 'fill-failed',
              pausedDetail: 'git worktree add failed',
            }),
            progress('m-2', 'paused', { pausedReason: 'runs' }),
          ],
        },
        handlers
      )
    );
    const resume = document.querySelector<HTMLElement>(
      '[data-slot=live-resume-all]'
    );
    expect(resume?.getAttribute('title')).toBe(
      '1 paused on a ceiling stay paused: raise it on the band'
    );
    await act(async () => {
      resume?.click();
      await Promise.resolve();
    });
    expect(handlers.resumed).toEqual(['m-1']);
  });

  test('finished leading waves fold to a count, and open on a click', () => {
    mount(
      dataWith({
        tasks: TASKS.map((t) =>
          t.meta.id === 't-b' || t.meta.id === 't-d' || t.meta.id === 't-e'
            ? { ...t, meta: { ...t.meta, status: 'landed' } }
            : t
        ),
        runs: [run('t-c'), run('l-1')],
      })
    );
    expect(node('t-a')).toBeNull();
    expect(node('t-c')?.getAttribute('data-state')).toBe('running');
    const fold = document.querySelector<HTMLElement>(
      '[data-live-band=m-1] [data-slot=live-band-fold]'
    );
    expect(fold?.textContent).toBe('1 landed wave · 4');
    act(() => fold?.click());
    expect(node('t-a')?.getAttribute('data-state')).toBe('done');
  });

  test('a project’s fan-out draws one sub-band per milestone', () => {
    const tasks = [
      task('p-1', { kind: 'project', title: 'Storefront' }),
      task('m-a', { kind: 'milestone', parent: 'p-1', title: 'Cart' }),
      task('m-b', { kind: 'milestone', parent: 'p-1', title: 'Search' }),
      task('a-1', { parent: 'm-a', status: 'working' }),
      task('a-2', { parent: 'm-a', blockedBy: ['a-1'] }),
      task('b-1', { parent: 'm-b' }),
    ];
    mount(
      dataWith({
        tasks,
        runs: [run('a-1')],
        sessions: [progress('p-1', 'active')],
        attention: [],
      })
    );
    expect(bands()).toEqual(['p-1']);
    expect(
      Array.from(
        document.querySelectorAll(
          '[data-live-band=p-1] [data-slot=flight-band-head]'
        ),
        (h) => h.getAttribute('data-band')
      )
    ).toEqual(['m-a', 'm-b']);
    expect(node('b-1')?.getAttribute('data-state')).toBe('queued');
  });

  test('only the bands near the viewport mount', () => {
    const tasks: TaskListItem[] = [];
    const sessions: EpicProgress[] = [];
    for (let m = 0; m < 12; m++) {
      const id = `m-${String(m).padStart(2, '0')}`;
      tasks.push(task(id, { kind: 'milestone', title: `Milestone ${id}` }));
      for (let i = 0; i < 8; i++) {
        tasks.push(task(`${id}-t${i}`, { parent: id }));
      }
      sessions.push(progress(id, 'active'));
    }
    mount(dataWith({ tasks, runs: [], sessions, attention: [] }));
    const mounted = bands();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(12);
  });

  test('with nothing in flight, offers what is ready to start', () => {
    const tasks = [
      task('m-9', { kind: 'milestone', title: 'Onboarding' }),
      task('w-1', { parent: 'm-9' }),
      task('w-2', { parent: 'm-9' }),
    ];
    mount(
      dataWith({
        tasks,
        runs: [],
        sessions: [],
        attention: [],
        readyIds: ['w-1', 'w-2'],
      })
    );
    expect(screen.getByText('Nothing in flight')).toBeTruthy();
    const row = document.querySelector('[data-slot=live-ready-row]');
    expect(row?.getAttribute('data-container')).toBe('m-9');
    expect(row?.textContent).toContain('2 ready of 2');
    expect(screen.getByRole('button', { name: /Send agents/ })).toBeTruthy();
  });
});
