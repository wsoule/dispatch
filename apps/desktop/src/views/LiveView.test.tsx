import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { MilestoneProgress, RunMeta } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { progress, run, task } from '../components/live/fixtures.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskAttention } from '../lib/taskAttention';
import { LiveView } from './LiveView';

beforeEach(() => window.localStorage.clear());
/** Steps time inside act until every mounted band has drawn its chart (a band defers it)
 * and every chart has laid out (elkjs is async), so no state update lands outside the
 * test. React applies an act's updates as it ends, hence one short act per step. */
async function settle() {
  const pending = () =>
    Array.from(document.querySelectorAll('[data-slot=live-band-canvas]')).some(
      (canvas) =>
        canvas.querySelector('[data-testid=milestone-map]') === null ||
        canvas.querySelector('[data-testid=chart-message]') !== null
    );
  for (let i = 0; i < 80; i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    if (!pending()) return;
  }
}

afterEach(async () => {
  await settle();
  cleanup();
});

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
    sessions?: MilestoneProgress[];
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
    milestones: tasks.filter((t) => t.meta.kind !== 'task'),
    tasksReady: true,
    runs,
    latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
    liveRunStateByTaskId: new Map(
      runs.filter((r) => r.state === 'running').map((r) => [r.taskId, r.state])
    ),
    attentionByTaskId: new Map(opts.attention ?? [['v-a', 'review']]),
    milestoneProgressById: new Map(sessions.map((p) => [p.milestoneId, p])),
    liveMilestoneSessions: sessions,
    mergeQueue: null,
    readyIds: new Set(opts.readyIds ?? []),
    linearLinks: {},
    handlePauseMilestone: (id: string) => {
      handlers.paused.push(id);
      return Promise.resolve();
    },
    handleResumeMilestone: (id: string) => {
      handlers.resumed.push(id);
      return Promise.resolve();
    },
    handleStopMilestone: () => Promise.resolve(),
    handleLandMilestone: () => Promise.resolve(),
    handleWorkMilestone: () => Promise.resolve(),
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

/** The scroller's padding above the first band: the
 * `.scroller` padding-top in LiveView.module.css. */
const LIST_TOP = 8;

function rectAt(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 1200,
    bottom: top + height,
    width: 1200,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Lays the band list out by hand, since happy-dom lays nothing out: a viewport
 * `viewHeight` tall, and the band list starting under the scroller's top padding, moved
 * up by the scroller's `scrollTop` the way a real scroll moves it. Bands measure 0, so
 * every band takes its known height (`liveBandHeight`). A scroll event re-measures.
 */
function layOut(viewHeight: number): HTMLElement | null {
  const scroller = document.querySelector<HTMLElement>(
    '[role=group][aria-label="Live work"]'
  );
  const list = scroller?.querySelector<HTMLElement>(':scope > ul');
  if (scroller == null || list == null) return null;
  scroller.getBoundingClientRect = () => rectAt(0, viewHeight);
  list.getBoundingClientRect = () => rectAt(LIST_TOP - scroller.scrollTop, 0);
  act(() => {
    fireEvent.scroll(scroller);
  });
  return scroller;
}

async function mount(
  data: DispatchProjectData,
  dispatchTask: (taskId: string) => Promise<void> = () => Promise.resolve(),
  onBack?: () => void,
  viewHeight = 4000
) {
  const calls = { opened: [] as string[], peeked: [] as string[] };
  const view = (d: DispatchProjectData) => (
    <LiveView
      data={d}
      bucketOf={() => null}
      asksByTask={new Map()}
      projectKey="test"
      dispatchTask={dispatchTask}
      onDispatchFailed={() => {}}
      onOpenTask={(id, tab) =>
        calls.opened.push(tab === undefined ? id : `${id}:${tab}`)
      }
      onPeekTask={(id) => calls.peeked.push(id)}
      onBack={onBack}
    />
  );
  const result = render(view(data));
  layOut(viewHeight);
  await settle();
  return {
    ...result,
    calls,
    /** Renders the view again with new data (the project's next refresh). */
    rerenderWith: async (d: DispatchProjectData) => {
      act(() => {
        result.rerender(view(d));
      });
      await settle();
    },
  };
}

const bands = () =>
  Array.from(document.querySelectorAll('[data-slot=live-band]')).map((b) =>
    b.getAttribute('data-live-band')
  );
/** A task's card in its band's chart, once the chart is laid out (elkjs is async). */
const card = (id: string) =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-chart-node="${id}"] button`
    );
    if (found === null) throw new Error(`no card ${id}`);
    return found;
  });
const drawn = (id: string) =>
  document.querySelector(`[data-chart-node="${id}"]`) !== null;
const group = () => screen.getByRole('group', { name: 'Live work' });
/** The inspector's Send agent, after a click selected a card. */
const sendAgent = () => screen.queryByRole('button', { name: 'Send agent' });
const bandHeight = (key: string) =>
  Number.parseFloat(
    document.querySelector<HTMLElement>(`[data-live-band="${key}"]`)?.style
      .height ?? 'NaN'
  );
const gaps = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role=group][aria-label="Live work"] > ul > li[aria-hidden="true"]'
    ),
    (li) => Number.parseFloat(li.style.height)
  );

/** Twelve active fan-outs of eight unblocked tasks each: every band is one wave of the
 * same height, several of them taller than an 800px viewport together. */
function twelveBands(): {
  tasks: TaskListItem[];
  sessions: MilestoneProgress[];
} {
  const tasks: TaskListItem[] = [];
  const sessions: MilestoneProgress[] = [];
  for (let m = 0; m < 12; m++) {
    const id = `m-${String(m).padStart(2, '0')}`;
    tasks.push(task(id, { kind: 'milestone', title: `Milestone ${id}` }));
    for (let i = 0; i < 8; i++) {
      tasks.push(task(`${id}-t${i}`, { parent: id }));
    }
    sessions.push(progress(id, 'active'));
  }
  return { tasks, sessions };
}

/** m-00 … m-11, the twelve bands' keys in the order they draw while all are active. */
const TWELVE = Array.from(
  { length: 12 },
  (_, m) => `m-${String(m).padStart(2, '0')}`
);

/**
 * Checks the band list's windows against the bands' own heights, with no scroll since
 * the last change. Walking the list's items in order, the mounted bands come in `order`
 * and each gap stands for a run of the bands between them: it must be exactly as tall
 * as that run (`heightOf`), so every mounted band sits where the bands before it end,
 * as its culling offset (`top`, from `liveBandHeight`) says, and the list is as tall as
 * every band together. No gap may reach into the viewport either (the scroller's
 * `scrollTop` and its laid-out height): what shows is always drawn bands, never a blank.
 */
function expectGapsMatch(
  order: readonly string[],
  heightOf: (key: string) => number
) {
  const scroller = group();
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.getBoundingClientRect().height;
  const items = Array.from(
    scroller.querySelectorAll<HTMLElement>(':scope > ul > li')
  );
  let next = 0;
  let y = LIST_TOP;
  for (const item of items) {
    const key = item.getAttribute('data-row-id');
    if (key !== null) {
      expect(key).toBe(order[next] ?? '');
      expect(bandHeight(key)).toBe(heightOf(key));
      y += heightOf(key);
      next++;
      continue;
    }
    // A gap: the bands it stands for, from the next one on, add up to its height.
    const px = Number.parseFloat(item.style.height);
    let sum = 0;
    const from = next;
    while (sum < px - 0.5 && next < order.length) {
      sum += heightOf(order[next] ?? '');
      next++;
    }
    expect({ from, px }).toEqual({ from, px: sum });
    expect({ from, blank: y < viewBottom && y + px > viewTop }).toEqual({
      from,
      blank: false,
    });
    y += px;
  }
  expect(next).toBe(order.length);
}

describe('LiveView', () => {
  test('draws a band per container in motion, running first, then paused, then the rest', async () => {
    await mount(dataWith());
    expect(bands()).toEqual(['m-1', '__loose', 'm-2', 'm-3']);
    expect(
      Array.from(
        document.querySelectorAll('[data-slot=live-band-title]'),
        (t) => t.textContent
      )
    ).toEqual(['Checkout', 'Loose work', 'Search', 'Billing']);
    // Each band is the dependency chart of its work, landed tasks hidden.
    for (const id of ['t-b', 't-c', 't-d', 't-e', 'l-1']) await card(id);
    expect(drawn('t-a')).toBe(false);
    expect(
      document.querySelectorAll('[data-live-band] [data-testid=milestone-map]')
        .length
    ).toBe(4);
  });

  test('hosted by App, the head reads Runs › Live: the Runs back chip, then the h1 alone, bands intact', async () => {
    const backs: string[] = [];
    await mount(dataWith(), undefined, () => backs.push('back'));
    const head = document.querySelector('[data-slot=page-header]');
    expect(head).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Live' })
    ).toBeTruthy();
    // No in-page trail: the topbar's reads project / Runs / Live.
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(head?.querySelector('[aria-current]')).toBeNull();
    // The back chip names its parent, Runs, and leads the head before the h1.
    const back = screen.getByRole('button', { name: 'Back to runs' });
    expect(back).toBe(screen.getByTestId('tasks-back'));
    expect(back.textContent).toBe('Runs');
    expect(
      back.compareDocumentPosition(
        screen.getByRole('heading', { level: 1, name: 'Live' })
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to tasks' })).toBeNull();
    fireEvent.click(back);
    expect(backs).toEqual(['back']);
    expect(bands()).toEqual(['m-1', '__loose', 'm-2', 'm-3']);
    cleanup();
    // On its own (no host) the head has no back chip, only the heading.
    await mount(dataWith());
    expect(screen.queryByTestId('tasks-back')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Live' })
    ).toBeTruthy();
  });

  test('the header adds every band up', async () => {
    await mount(
      dataWith({
        sessions: [
          progress('m-1', 'active', { concurrency: 2, maxSpendUsd: 20 }, 4),
          progress('m-2', 'paused', { pausedReason: 'human' }),
        ],
      })
    );
    const text = (slot: string) =>
      document.querySelector(`[data-slot=${slot}]`)?.textContent;
    const header = document.querySelector('[data-slot=live-header]');
    expect(header?.getAttribute('aria-label')).toBe('Live');
    // The header's one-row strip (owner decision 2026-11-03), not the stats panel.
    expect(header?.getAttribute('data-variant')).toBe('compact');
    const slots = header?.querySelector(
      '[data-slot=live-slots] [role=progressbar]'
    );
    expect(slots?.getAttribute('aria-label')).toBe('Agent slots');
    expect(slots?.getAttribute('aria-valuetext')).toBe('1 of 4 slots in use');
    // Each cell reads its label, then its value.
    expect(text('live-running')).toBe('Running2');
    expect(text('live-queued')).toBe('Queued1');
    expect(
      document
        .querySelector('[data-slot=live-queued]')
        ?.firstElementChild?.getAttribute('title')
    ).toBe('Starts on its own as a fan-out slot frees');
    expect(text('live-teammate')).toBe('Blocked on teammates0');
    // With no spend today the value is the live fan-outs' settled spend ("Today" keys
    // today's). What it is measured against is the note, in the cell's hint (owner
    // decision 2026-11-04) and still in its text for a screen reader; the title says it
    // in full and is the cell's accessible description.
    const spend = document.querySelector('[data-slot=live-spend] > div');
    expect(spend?.textContent).toBe('Spend$4of $20 ceilings');
    expect(spend?.querySelector(':scope > .srOnly')?.textContent).toBe(
      'of $20 ceilings'
    );
    const described = spend?.getAttribute('aria-describedby');
    const title = described ? document.getElementById(described) : null;
    expect(title?.hidden).toBe(true);
    expect(title?.textContent).toBe(
      '$4 settled in the live fan-outs, of their $20 ceilings'
    );
  });

  test('a selected card that may start offers Send agent, never a teammate’s', async () => {
    const sent: string[] = [];
    await mount(dataWith(), (id) => {
      sent.push(id);
      return new Promise(() => {});
    });
    fireEvent.click(await card('t-d'));
    act(() => sendAgent()?.click());
    expect(sent).toEqual(['t-d']);
    // Optimistic: it is running at once, so nothing more to send.
    expect(sendAgent()).toBeNull();
    fireEvent.click(await card('t-e'));
    expect(screen.getByTestId('chart-inspector').textContent).toContain('t-e');
    expect(sendAgent()).toBeNull();
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

    test('Send agent at my own task, never at Maya’s', async () => {
      const sent: string[] = [];
      await mount(mayas(), (id) => {
        sent.push(id);
        return new Promise(() => {});
      });
      fireEvent.click(await card('t-x'));
      expect(sendAgent()).toBeNull();
      // Maya's fan-out never starts it, but I may by hand.
      fireEvent.click(await card('t-y'));
      act(() => sendAgent()?.click());
      expect(sent).toEqual(['t-y']);
    });

    test('work waiting on my own task is not waiting on a teammate', async () => {
      await mount(mayas());
      expect(
        document.querySelector('[data-slot=live-teammate]')?.textContent
      ).toBe('Blocked on teammates0');
    });
  });

  test('a double click quick-looks a card’s task, and so does the inspector’s Open task', async () => {
    const view = await mount(dataWith());
    fireEvent.doubleClick(await card('l-1'));
    expect(view.calls.peeked).toEqual(['l-1']);
    fireEvent.click(await card('t-c'));
    act(() => screen.getByRole('button', { name: 'Open task' }).click());
    expect(view.calls.peeked).toEqual(['l-1', 't-c']);
    expect(view.calls.opened).toEqual([]);
  });

  test('a band links to its full Flight Plan', async () => {
    const view = await mount(dataWith());
    const open = document.querySelector<HTMLElement>(
      '[data-live-band=m-1] [data-slot=live-band-open-plan]'
    );
    act(() => open?.click());
    expect(view.calls.opened).toEqual(['m-1:plan']);
  });

  test('Pause all asks first, then pauses every active fan-out', async () => {
    const handlers = { paused: [] as string[], resumed: [] as string[] };
    await mount(dataWith({}, handlers));
    act(() =>
      document.querySelector<HTMLElement>('[data-slot=live-pause-all]')?.click()
    );
    expect(handlers.paused).toEqual([]);
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Pause the fan-out?',
    });
    expect(confirm.getAttribute('data-slot')).toBe('live-pause-all-confirm');
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-slot=live-pause-all-confirm] [data-confirm]'
        )
        ?.click();
      await Promise.resolve();
    });
    // Only the active one: Search is already paused.
    expect(handlers.paused).toEqual(['m-1']);
  });

  test('with nothing filling slots, Resume all restarts what someone paused', async () => {
    const handlers = { paused: [] as string[], resumed: [] as string[] };
    await mount(
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
    await mount(
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

  test('a project’s fan-out charts every milestone’s work in one band', async () => {
    const tasks = [
      task('p-1', { kind: 'project', title: 'Storefront' }),
      task('m-a', { kind: 'milestone', parent: 'p-1', title: 'Cart' }),
      task('m-b', { kind: 'milestone', parent: 'p-1', title: 'Search' }),
      task('a-1', { parent: 'm-a', status: 'working' }),
      task('a-2', { parent: 'm-a', blockedBy: ['a-1'] }),
      task('b-1', { parent: 'm-b' }),
    ];
    await mount(
      dataWith({
        tasks,
        runs: [run('a-1')],
        sessions: [progress('p-1', 'active')],
        attention: [],
      })
    );
    expect(bands()).toEqual(['p-1']);
    for (const id of ['a-1', 'a-2', 'b-1']) await card(id);
  });

  test('only the bands near the viewport mount', async () => {
    const { tasks, sessions } = twelveBands();
    await mount(
      dataWith({ tasks, runs: [], sessions, attention: [] }),
      undefined,
      undefined,
      800
    );
    const mounted = bands();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(12);
    // The first bands, in order; the rest stand as one spacer item hidden from
    // assistive tech, as tall as the bands it stands for (every band here is the same
    // eight-card wave, so each is a mounted band's height).
    expect(mounted).toEqual(
      Array.from(
        { length: mounted.length },
        (_, m) => `m-${String(m).padStart(2, '0')}`
      )
    );
    const height = bandHeight('m-00');
    expect(height).toBeGreaterThan(0);
    expect(gaps()).toEqual([(12 - mounted.length) * height]);
    // The list is layout only: each band is its own labelled section, and a windowed
    // list would announce a count of whichever bands happen to be mounted.
    const list = group().querySelector(':scope > ul');
    expect(list?.getAttribute('role')).toBe('presentation');
    for (const item of Array.from(list?.children ?? [])) {
      expect(item.getAttribute('role')).toBe('presentation');
    }
  });

  test('every mounted band is its own compositing layer', () => {
    // WebKit repaints every band that shares a backing when one mounts or unmounts, so
    // each band's item holds a layer. bun loads a CSS module as an empty map, so the
    // source and the sheet are read instead of the rendered class.
    const source = readFileSync(join(import.meta.dir, 'LiveView.tsx'), 'utf8');
    expect(source).toMatch(
      /data-row-id=\{key\}\s+className=\{styles\.bandItem\}/
    );
    const sheet = readFileSync(
      join(import.meta.dir, 'LiveView.module.css'),
      'utf8'
    );
    expect(sheet).toMatch(/\.bandItem \{[^}]*will-change: transform;/);
  });

  test('every band is one fixed height, so every gap is the bands it stands for', async () => {
    const { tasks, sessions } = twelveBands();
    const view = await mount(
      dataWith({ tasks, runs: [], sessions, attention: [] }),
      undefined,
      undefined,
      800
    );
    const scroller = group();
    act(() => {
      scroller.scrollTop = 5000;
      fireEvent.scroll(scroller);
    });
    const before = bandHeight(bands()[0] ?? '');
    expectGapsMatch(TWELVE, () => before);
    // Two more cards in every band: the chart fits them in the same height.
    const more = [...tasks];
    for (let m = 0; m < 12; m++) {
      const id = `m-${String(m).padStart(2, '0')}`;
      for (let i = 0; i < 2; i++)
        more.push(task(`${id}-x${i}`, { parent: id }));
    }
    await view.rerenderWith(
      dataWith({ tasks: more, runs: [], sessions, attention: [] })
    );
    expect(bandHeight(bands()[0] ?? '')).toBe(before);
    expectGapsMatch(TWELVE, () => before);
  });

  test('with nothing in flight, offers what is ready to start', async () => {
    const tasks = [
      task('m-9', { kind: 'milestone', title: 'Onboarding' }),
      task('w-1', { parent: 'm-9' }),
      task('w-2', { parent: 'm-9' }),
    ];
    await mount(
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
