import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { MilestoneProgress, RunMeta } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { progress, run, task } from '../components/live/fixtures.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskAttention } from '../lib/taskAttention';
import { LiveView } from './LiveView';

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

/** The scroller's padding above the first band: LIST_TOP in LiveView.tsx, the
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

function mount(
  data: DispatchProjectData,
  dispatchTask: (taskId: string) => Promise<void> = () => Promise.resolve(),
  onBack?: () => void,
  viewHeight = 4000
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
      onBack={onBack}
    />
  );
  const result = render(view(data));
  layOut(viewHeight);
  return {
    ...result,
    calls,
    /** Renders the view again with new data (the project's next refresh). */
    rerenderWith: (d: DispatchProjectData) => {
      act(() => {
        result.rerender(view(d));
      });
    },
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

  test('hosted under Tasks, the header leads with the back chip to the Tasks list, bands intact', () => {
    const backs: string[] = [];
    mount(dataWith(), undefined, () => backs.push('back'));
    expect(document.querySelector('[data-slot=page-header]')).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Live' })
    ).toBeTruthy();
    // The trail is the project, then this page: Live is the current page.
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail.textContent).toBe('demo›Live');
    expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Live'
    );
    fireEvent.click(screen.getByTestId('tasks-back'));
    expect(backs).toEqual(['back']);
    expect(bands()).toEqual(['m-1', '__loose', 'm-2', 'm-3']);
    cleanup();
    // On its own (no host) the header has no back chip.
    mount(dataWith());
    expect(screen.queryByTestId('tasks-back')).toBeNull();
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
    const header = document.querySelector('[data-slot=live-header]');
    expect(header?.getAttribute('aria-label')).toBe('Live');
    const slots = header?.querySelector(
      '[data-slot=live-slots] [role=progressbar]'
    );
    expect(slots?.getAttribute('aria-label')).toBe('Agent slots');
    expect(slots?.getAttribute('aria-valuetext')).toBe('1 of 4 slots in use');
    // Each cell reads its label, then its value.
    expect(text('live-running')).toBe('Running2');
    expect(text('live-queued')).toBe('Queued1');
    expect(
      document.querySelector('[data-slot=live-queued]')?.getAttribute('title')
    ).toBe('Starts on its own as a fan-out slot frees');
    expect(text('live-teammate')).toBe('Waiting on teammates0');
    // The short amount is the value; what it is measured against is the note.
    expect(text('live-spend')).toBe('Spend$4of $20 ceilings');
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
      ).toBe('Waiting on teammates0');
    });
  });

  test('Enter and Space quick-look the task, o opens its page; nothing is drawn beside the bands', () => {
    const view = mount(dataWith());
    act(() => group().focus());
    press('Enter');
    expect(view.calls.peeked).toEqual(['t-a']);
    press('o');
    press(' ');
    expect(view.calls.opened).toEqual(['t-a']);
    expect(view.calls.peeked).toEqual(['t-a', 't-a']);
    expect(document.querySelector('[data-slot=task-pane]')).toBeNull();
    // Escape is left to the shell (which closes the drawer): not prevented here.
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      group().dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(false);
  });

  test('a card click quick-looks its task and moves the cursor to it', () => {
    const view = mount(dataWith());
    act(() => node('l-1')?.click());
    expect(view.calls.peeked).toEqual(['l-1']);
    expect(group().getAttribute('aria-activedescendant')).toBe(
      'flight-node-l-1'
    );
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
    const { tasks, sessions } = twelveBands();
    mount(
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

  test('J brings the next band’s title to the top of the list', () => {
    mount(dataWith(), undefined, undefined, 300);
    const scroller = group();
    act(() => scroller.focus());
    expect(cursor()).toBe('flight-node-t-a');
    const first = bandHeight('m-1');
    press('J');
    expect(cursor()).toBe('flight-node-l-1');
    expect(scroller.scrollTop).toBe(LIST_TOP + first);
    expect(bands()).toContain('__loose');
    const loose = bandHeight('__loose');
    press('J');
    expect(cursor()).toBe('flight-node-u-a');
    expect(scroller.scrollTop).toBe(LIST_TOP + first + loose);
    expect(bands()).toContain('m-2');
  });

  test('j into a band the window left out mounts it, so the cursor is always drawn', () => {
    const { tasks, sessions } = twelveBands();
    mount(
      dataWith({ tasks, runs: [], sessions, attention: [] }),
      undefined,
      undefined,
      800
    );
    const scroller = group();
    act(() => scroller.focus());
    expect(cursor()).toBe('flight-node-m-00-t0');
    // Scroll far down by hand: the cursor's band stays mounted, its neighbour does not.
    act(() => {
      scroller.scrollTop = 6000;
      fireEvent.scroll(scroller);
    });
    expect(bands()).toContain('m-00');
    expect(bands()).not.toContain('m-01');
    // Eight cards down the first band's one wave, then into the next band.
    for (let i = 0; i < 8; i++) press('j');
    expect(cursor()).toBe('flight-node-m-01-t0');
    expect(bands()).toContain('m-01');
    expect(document.getElementById(cursor() ?? '')).not.toBeNull();
    const height = bandHeight('m-01');
    expectGapsMatch(TWELVE, () => height);
  });

  test('a re-sort that moves the cursor’s band away keeps it drawn', () => {
    const { tasks, sessions } = twelveBands();
    const view = mount(
      dataWith({ tasks, runs: [], sessions, attention: [] }),
      undefined,
      undefined,
      800
    );
    act(() => group().focus());
    press('j');
    expect(cursor()).toBe('flight-node-m-00-t1');
    // m-00's fan-out is paused: its band sorts after every active one, far below.
    view.rerenderWith(
      dataWith({
        tasks,
        runs: [],
        sessions: sessions.map((s) =>
          s.milestoneId === 'm-00'
            ? progress('m-00', 'paused', { pausedReason: 'human' })
            : s
        ),
        attention: [],
      })
    );
    expect(cursor()).toBe('flight-node-m-00-t1');
    expect(bands()).toContain('m-00');
    expect(bands().at(-1)).toBe('m-00');
    expect(document.getElementById(cursor() ?? '')).not.toBeNull();
    const height = bandHeight('m-00');
    expectGapsMatch([...TWELVE.slice(1), 'm-00'], () => height);
  });

  test('bands that grow re-window at once: every gap is the bands it stands for', () => {
    const { tasks, sessions } = twelveBands();
    const view = mount(
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
    // Two more cards in every band: each band's wave is taller. No scroll follows.
    const more = [...tasks];
    for (let m = 0; m < 12; m++) {
      const id = `m-${String(m).padStart(2, '0')}`;
      for (let i = 0; i < 2; i++)
        more.push(task(`${id}-x${i}`, { parent: id }));
    }
    view.rerenderWith(
      dataWith({ tasks: more, runs: [], sessions, attention: [] })
    );
    const after = bandHeight(bands()[0] ?? '');
    expect(after).toBeGreaterThan(before);
    expectGapsMatch(TWELVE, () => after);
  });

  test('a fold re-windows at once, opening or closing', () => {
    // Every band's first wave has landed (folded to a count); its second is running.
    const tasks: TaskListItem[] = [];
    const sessions: MilestoneProgress[] = [];
    const runs: RunMeta[] = [];
    for (let m = 0; m < 12; m++) {
      const id = `m-${String(m).padStart(2, '0')}`;
      tasks.push(task(id, { kind: 'milestone', title: `Milestone ${id}` }));
      for (let i = 0; i < 6; i++) {
        tasks.push(task(`${id}-a${i}`, { parent: id, status: 'landed' }));
      }
      tasks.push(
        task(`${id}-b0`, {
          parent: id,
          status: 'working',
          blockedBy: [`${id}-a0`],
        })
      );
      runs.push(run(`${id}-b0`));
      sessions.push(progress(id, 'active'));
    }
    mount(
      dataWith({ tasks, runs, sessions, attention: [] }),
      undefined,
      undefined,
      800
    );
    const folded = bandHeight('m-00');
    // m-00's own height as drawn now; every other band stays folded.
    const heights = () => {
      const first = bandHeight('m-00');
      return (key: string) => (key === 'm-00' ? first : folded);
    };
    expectGapsMatch(TWELVE, heights());
    const fold = () =>
      document.querySelector<HTMLElement>(
        '[data-live-band=m-00] [data-slot=live-band-fold]'
      );
    expect(fold()?.getAttribute('aria-expanded')).toBe('false');
    act(() => fold()?.click());
    expect(fold()?.getAttribute('aria-expanded')).toBe('true');
    expect(bandHeight('m-00')).toBeGreaterThan(folded);
    expectGapsMatch(TWELVE, heights());
    // A scroll while it is open windows the list at its full height; folding it again
    // pulls every band below it up, and the windows follow before the next scroll.
    act(() => {
      fireEvent.scroll(group());
    });
    expectGapsMatch(TWELVE, heights());
    act(() => fold()?.click());
    expect(bandHeight('m-00')).toBe(folded);
    expectGapsMatch(TWELVE, heights());
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
