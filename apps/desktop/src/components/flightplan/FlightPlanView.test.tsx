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
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { setActiveStatusModel } from '../../lib/statusModel';

/** What the plan's chart reads beyond the data: no buckets, no asks. */
const CHART = {
  bucketOf: () => null,
  asksByTask: new Map<string, number>(),
  projectKey: 'test',
};
// The split pane mounts the task page, whose Review mode pulls in the Pierre diff; its
// worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { ContainerFlightPlanSection, FlightPlanHostContext } =
  await import('./ContainerFlightPlanSection');
const { FlightPlan } = await import('./FlightPlanView');

beforeEach(() => window.localStorage.clear());
/** Steps time inside act until the plan's chart has laid out (elkjs is async), so no
 * state update lands outside the test. React applies an act's updates as it ends, hence
 * one short act per step. */
async function settle() {
  for (let i = 0; i < 80; i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    if (document.querySelector('[data-testid=chart-message]') === null) return;
  }
}

// Unmount before resetting, so the reset does not redraw a mounted plan outside act.
afterEach(async () => {
  await settle();
  cleanup();
  setActiveStatusModel(null);
});

function task(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: `Title ${id}`,
      status: 'ready',
      kind: 'task',
      parent: 'e-1',
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      writes: ['src/x.ts'],
      external: null,
      created: `2026-09-01T00:00:0${id.slice(-1)}.000Z`,
      updated: '2026-09-10T00:00:00.000Z',
      dueDate: null,
      ...overrides,
    },
  } as TaskListItem;
}

const LIVE: RunMeta = {
  id: 'r-b',
  taskId: 't-b',
  taskTitle: 'Title t-b',
  executor: 'claude',
  state: 'running',
  branch: 'dispatch/t-b',
  baseBranch: 'milestone/e-1',
  worktreePath: '/tmp',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  costUsd: 0.42,
};

// a (landed) and b (an agent on it) → c → d; e is free to go; f is Maya's, started.
function plan(
  overrides: Partial<Record<string, Partial<TaskListItem['meta']>>> = {}
) {
  const base = [
    task('e-1', { kind: 'milestone', parent: null, status: 'working' }),
    task('t-a', { status: 'landed' }),
    task('t-b', { status: 'working' }),
    task('t-c', { blockedBy: ['t-a', 't-b'] }),
    task('t-d', { blockedBy: ['t-c'] }),
    task('t-e'),
    task('t-f', { status: 'working', assignee: 'human:maya' }),
  ];
  return base.map((t) => ({
    ...t,
    meta: { ...t.meta, ...overrides[t.meta.id] },
  }));
}

function progress(
  state: 'active' | 'paused',
  concurrency = 2,
  milestoneId = 'e-1'
): MilestoneProgress {
  return {
    milestoneId,
    active: state === 'active',
    session: {
      milestoneId,
      concurrency,
      executor: 'fake',
      state,
      maxSpendUsd: null,
      maxRuns: null,
      startedAt: '2026-09-20T00:00:00.000Z',
      startedBy: null,
      scope: 'plan',
      updatedAt: '2026-09-20T00:00:00.000Z',
      active: state === 'active',
    },
    spend: {
      settledUsd: 0,
      liveCount: 1,
      estimatedLiveUsd: 0,
      runsStarted: 1,
      maxSpendUsd: null,
      maxRuns: null,
    },
    children: [],
    waves: [],
    liveRuns: [],
  };
}

function dataWith(
  tasks: TaskListItem[],
  runs: RunMeta[] = [LIVE],
  sessions: MilestoneProgress[] = []
): DispatchProjectData {
  const noop = () => Promise.resolve();
  return {
    client: {},
    port: 1,
    config: null,
    tasks,
    tasksIncludingArchived: tasks,
    milestones: tasks.filter((t) => t.meta.kind !== 'task'),
    tasksReady: true,
    runs,
    latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
    liveRunStateByTaskId: new Map(
      runs.filter((r) => r.state === 'running').map((r) => [r.taskId, r.state])
    ),
    milestoneProgressById: new Map(sessions.map((p) => [p.milestoneId, p])),
    linearLinks: {},
    branches: [],
    readyIds: new Set(),
    handlePauseMilestone: noop,
    handleResumeMilestone: noop,
    handleStopMilestone: noop,
    handleLandMilestone: noop,
    handleWorkMilestone: noop,
  } as unknown as DispatchProjectData;
}

async function mount(
  data: DispatchProjectData,
  dispatchTask: (taskId: string) => Promise<void> = () => Promise.resolve(),
  containerId = 'e-1'
) {
  const opened: string[] = [];
  const view = (d: DispatchProjectData) => (
    <FlightPlan
      {...CHART}
      containerId={containerId}
      data={d}
      dispatchTask={dispatchTask}
      onDispatchFailed={() => {}}
      onOpenTask={(id) => opened.push(id)}
      openIn="page"
    />
  );
  const result = render(view(data));
  await settle();
  return {
    ...result,
    opened,
    rerenderWith: async (d: DispatchProjectData) => {
      result.rerender(view(d));
      await settle();
    },
  };
}

/** A task's card on the plan's chart, once laid out (elkjs is async). */
const card = (id: string) =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-chart-node="${id}"] button`
    );
    if (found === null) throw new Error(`no card ${id}`);
    return found;
  });
/** The inspector's Send agent, after a click selected a card. */
const sendAgent = () => screen.queryByRole('button', { name: 'Send agent' });
/** A project plan's Milestones view, then one milestone selected: its inspector. */
async function milestoneInspector(title: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('radio', { name: 'Milestones' }));
  const found = (await screen.findAllByTestId('milestone-node')).find((el) =>
    el.textContent?.includes(title)
  );
  if (found === undefined) throw new Error(`no milestone ${title}`);
  fireEvent.click(found);
  return screen.getByTestId('chart-inspector');
}

describe('FlightPlan', () => {
  test('draws every task of the plan on the chart, linked or not, with no Milestones view', async () => {
    await mount(dataWith(plan()));
    for (const id of ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f']) await card(id);
    // One milestone's plan: the Tasks chart alone, its inspector shut until a pick.
    expect(screen.queryByRole('radio', { name: 'Milestones' })).toBeNull();
    expect(screen.queryByTestId('chart-inspector')).toBeNull();
    expect(screen.getByTestId('milestone-map-summary').textContent).toBe(
      '6 tasks · 3 waits · 1/6 landed'
    );
  });
  test('under an active session the header counts the slots in use', async () => {
    await mount(dataWith(plan({ 't-g': {} }), [LIVE], [progress('active', 2)]));
    // The header's slots in use are text (no meter track: owner decision 2026-11-04),
    // said in words for a screen reader.
    const slots = document.querySelector(
      '[data-slot=flight-header] [data-slot=flight-slots]'
    );
    expect(slots?.querySelector('[aria-hidden=true]')?.textContent).toBe('1/2');
    expect(slots?.querySelector('.srOnly')?.textContent).toBe(
      '1 of 2 agent slots in use'
    );
    expect(document.querySelector('[role=progressbar]')).toBeNull();
  });

  test('a picked card opens from the inspector, and one that may start sends an agent', async () => {
    const sent: string[] = [];
    const view = await mount(dataWith(plan()), (id) => {
      sent.push(id);
      return new Promise(() => {});
    });
    fireEvent.click(await card('t-e'));
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(view.opened).toEqual(['t-e']);
    await act(async () => {
      sendAgent()?.click();
      await Promise.resolve();
    });
    expect(sent).toEqual(['t-e']);
    // Optimistic: it is running at once, so there is nothing more to send.
    expect(sendAgent()).toBeNull();
    // A blocked card is not dispatchable.
    fireEvent.click(await card('t-c'));
    expect(screen.getByTestId('chart-inspector').textContent).toContain('t-c');
    expect(sendAgent()).toBeNull();
  });
  test('in a fan-out a teammate started, Send agent is offered at my own task and never theirs', async () => {
    const tasks = [
      task('e-1', { kind: 'milestone', parent: null, status: 'working' }),
      task('t-1', { assignee: 'human:maya' }),
      task('t-2', { assignee: 'human:wyat' }),
    ];
    const base = progress('active');
    const mayas: MilestoneProgress = {
      ...base,
      session:
        base.session === null
          ? null
          : { ...base.session, startedBy: 'human:maya' },
    };
    const sent: string[] = [];
    await mount(
      {
        ...dataWith(tasks, [], [mayas]),
        localHuman: 'human:wyat',
      } as DispatchProjectData,
      (id) => {
        sent.push(id);
        return new Promise(() => {});
      }
    );
    fireEvent.click(await card('t-1'));
    expect(sendAgent()).toBeNull();
    fireEvent.click(await card('t-2'));
    act(() => sendAgent()?.click());
    expect(sent).toEqual(['t-2']);
  });
  test('a project’s plan offers the Milestones view, one card per milestone', async () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('e-2', { kind: 'milestone', parent: 'e-p', title: 'Beta' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-2', blockedBy: ['t-1'] }),
    ];
    await mount(dataWith(tasks, []), undefined, 'e-p');
    for (const id of ['t-1', 't-2']) await card(id);
    fireEvent.click(screen.getByRole('radio', { name: 'Milestones' }));
    const titles = (await screen.findAllByTestId('milestone-node')).map(
      (el) => el.textContent ?? ''
    );
    expect(titles.some((t) => t.includes('Alpha'))).toBe(true);
    expect(titles.some((t) => t.includes('Beta'))).toBe(true);
  });
  test('a project’s header fans out every milestone, and theirs step aside while it runs', async () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('e-2', { kind: 'milestone', parent: 'e-p', title: 'Beta' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-2' }),
      task('t-3', { parent: 'e-2' }),
    ];
    const header = () =>
      document.querySelector('[data-slot=flight-header]')?.textContent ?? '';
    const view = await mount(dataWith(tasks, []), undefined, 'e-p');
    expect(header()).toContain('Send agents');
    // The header's one-row strip (owner decision 2026-11-03), not the stats panel.
    expect(
      document
        .querySelector('[data-slot=flight-header] ul[aria-label="Flight plan"]')
        ?.getAttribute('data-variant')
    ).toBe('compact');
    // A milestone's own fan-out sits in its inspector.
    expect((await milestoneInspector('Beta')).textContent).toContain(
      'Send agents'
    );
    // The strip reads label then value, cell by cell; with no fan-out nothing is
    // queued, only ready, and holds no slots (the Running cell's hint says so).
    expect(
      Array.from(
        document.querySelectorAll('[data-slot=flight-header] li'),
        (cell) => cell.textContent
      )
    ).toEqual(['Running0', 'Ready3', 'Landed0/3', 'Critical path1~20m']);

    // The project's session owns every milestone's work: one queue, its slots.
    await view.rerenderWith(
      dataWith(tasks, [], [progress('active', 1, 'e-p')])
    );
    expect(screen.getByTestId('chart-inspector').textContent).not.toContain(
      'Send agents'
    );
  });

  test('the agent slots menu moves a live session to a new ceiling', async () => {
    const calls: string[] = [];
    const data = {
      ...dataWith(plan(), [LIVE], [progress('active', 2)]),
      handlePauseMilestone: (id: string) => {
        calls.push(`pause ${id}`);
        return Promise.resolve();
      },
      handleResumeMilestone: (id: string, opts?: { concurrency?: number }) => {
        calls.push(`resume ${id} ${String(opts?.concurrency)}`);
        return Promise.resolve();
      },
    } as DispatchProjectData;
    await mount(data);
    // The trigger sits in the header's Running cell, right after the slots text that prints
    // the total, so it is an icon button: its name says the slots it would change.
    const trigger = screen.getByRole('button', {
      name: 'Agent slots for e-1: 2 slots',
    });
    expect(trigger.textContent).toBe('');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    const cell = trigger.closest('li');
    expect(
      cell?.querySelector('[data-slot=flight-slots]')?.nextElementSibling
    ).toBe(trigger);
    expect(cell?.closest('ul')?.getAttribute('aria-label')).toBe('Flight plan');
    // A menu places itself a microtask after it opens, so let the queue drain.
    const settle = (work: () => void) =>
      act(async () => {
        work();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    await settle(() => fireEvent.click(trigger));
    expect(
      screen.getByRole('menu', { name: 'Agent slots for e-1' })
    ).toBeTruthy();
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map((row) => row.textContent)).toEqual([
      '1×',
      '2×',
      '3×',
      '4×',
    ]);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    // The checked row changes nothing; another pauses, then resumes at it.
    await settle(() => fireEvent.click(rows[1]));
    expect(calls).toEqual([]);
    await settle(() => fireEvent.click(trigger));
    await settle(() =>
      fireEvent.click(screen.getAllByRole('menuitemradio')[2])
    );
    expect(calls).toEqual(['pause e-1', 'resume e-1 3']);
  });

  // The picker is an icon button inside the Running cell, whose own hint (the queued and
  // landed counts) is a Tooltip on the whole cell: the picker says what it does in a
  // library Tooltip of its own, and the cell's hint keeps away from it and its menu.
  test("the slots picker has its own hint, and the Running cell's hint keeps away from it", async () => {
    await mount(dataWith(plan(), [LIVE], [progress('active', 2)]));
    const trigger = screen.getByRole('button', {
      name: 'Agent slots for e-1: 2 slots',
    });
    expect(trigger.hasAttribute('title')).toBe(false);
    const cell = trigger.closest('li')?.firstElementChild;
    if (!(cell instanceof HTMLElement)) throw new Error('no running cell');
    expect(cell.hasAttribute('data-hint')).toBe(true);
    const words = cell.querySelector('[data-slot=flight-slots]');
    if (!(words instanceof HTMLElement)) throw new Error('no slots text');
    const tips = () =>
      screen
        .queryAllByRole('tooltip', { hidden: true })
        .map((tip) => tip.textContent);
    const pause = (ms: number) =>
      act(() => new Promise((resolve) => setTimeout(resolve, ms)));
    const mouse = { pointerType: 'mouse' };
    const PICKER_TIP = 'Change the agent slots (2 slots now)';
    // Keyboard focus shows the picker's words at once, and not the cell's.
    act(() => trigger.focus());
    expect(tips()).toEqual([PICKER_TIP]);
    expect(trigger.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', { hidden: true }).id
    );
    act(() => trigger.blur());
    expect(tips()).toEqual([]);
    // A hover on the picker: its own words only, after the delay.
    await pause(450);
    fireEvent.pointerEnter(trigger, mouse);
    await pause(350);
    expect(tips()).toEqual([PICKER_TIP]);
    // On to the slots text beside it: the cell's hint takes over.
    fireEvent.pointerLeave(trigger, { ...mouse, relatedTarget: words });
    fireEvent.pointerOver(words, { ...mouse, relatedTarget: trigger });
    await pause(350);
    expect(tips()).toHaveLength(1);
    expect(tips()[0]).toStartWith('1 of 2 agent slots in use; ');
    fireEvent.pointerLeave(words, mouse);
    await pause(200);
    expect(tips()).toEqual([]);
    // The menu opened from the keyboard: a hover on the cell opens no hint over it, so
    // one Escape closes the menu and hands focus back to the picker.
    act(() => trigger.focus());
    await act(async () => {
      fireEvent.keyDown(trigger, { key: 'Enter' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const menu = screen.getByRole('menu', { name: 'Agent slots for e-1' });
    expect(menu.contains(document.activeElement)).toBe(true);
    await pause(450);
    fireEvent.pointerEnter(words, mouse);
    await pause(350);
    expect(tips()).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.pointerLeave(words, mouse);
  });

  test("the header's verbs are only Pause and Stop: the spend and the waves are strip cells", async () => {
    const waves = [
      { index: 1, total: 2, byPhase: { landed: 2 } },
      { index: 2, total: 1, byPhase: { working: 1 } },
    ];
    await mount(
      dataWith(
        plan(),
        [LIVE],
        [
          {
            ...progress('active', 2),
            spend: {
              settledUsd: 9.81,
              liveCount: 1,
              estimatedLiveUsd: 0,
              runsStarted: 2,
              maxSpendUsd: 10,
              maxRuns: null,
            },
            waves,
          },
        ]
      )
    );
    const header = document.querySelector<HTMLElement>(
      '[data-slot=flight-header]'
    );
    const list = screen.getByRole('list', { name: 'Flight plan' });
    // No pill or strip beside the verbs: the row's end holds the two buttons alone,
    // icon-only (owner decision 2026-11-04), still named Pause and Stop.
    expect(header?.querySelector('[data-slot=spend-pill]')).toBeNull();
    const pause = screen.getByRole('button', { name: 'Pause' });
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(list.contains(pause)).toBe(false);
    expect(
      Array.from(pause.parentElement?.children ?? [], (el) => [
        el.getAttribute('aria-label'),
        el.textContent,
      ])
    ).toEqual([
      ['Pause', ''],
      ['Stop', ''],
    ]);
    expect(pause.parentElement).toBe(stop.parentElement);
    // The spend is a cell, amber near its ceiling with a shape and words besides.
    const spend = list.querySelector('[data-slot=flight-spend]');
    // Key, value (with its words for a screen reader), then the note, which is in the
    // cell's hint while fanning out (owner decision 2026-11-04) and so on screen only
    // for a screen reader (srOnly); the title is the cell's hidden description.
    const inner = spend?.firstElementChild;
    expect(inner?.textContent).toBe(
      ['Spend', '$9.81', ', near its ceiling', 'of $10'].join('')
    );
    expect(inner?.querySelector(':scope > .srOnly')?.textContent).toBe(
      'of $10'
    );
    const described = inner?.getAttribute('aria-describedby');
    const title = described ? document.getElementById(described) : null;
    expect(title?.hidden).toBe(true);
    expect(
      title?.textContent?.startsWith('$9.81 settled of the $10 ceiling')
    ).toBe(true);
    expect(spend?.getAttribute('data-tone')).toBe('warning');
    expect(spend?.querySelector('svg')).not.toBeNull();
    // Near its ceiling the spend comes straight after the running cell, where the
    // strip's fade never reaches, rather than after the counts.
    const order = Array.from(list.children, (li) =>
      li.getAttribute('data-slot')
    );
    expect(order.slice(0, 2)).toEqual(['flight-stat', 'flight-spend']);
    expect(list.children[0]?.textContent?.startsWith('Running')).toBe(true);
    // The waves are a cell with each wave named, last.
    const wavesCell = list.querySelector('[data-slot=flight-waves]');
    expect(wavesCell?.textContent).toBe('WavesWave 1: passedWave 2: active');
    expect(order.at(-1)).toBe('flight-waves');
  });

  test('a paused plan leads its strip with the spend and has no slots picker', async () => {
    await mount(dataWith(plan(), [LIVE], [progress('paused', 2)]));
    const list = screen.getByRole('list', { name: 'Flight plan' });
    // The paused verbs leave the strip its narrowest, so the amount Raise ceiling… asks
    // about is the first cell.
    expect(list.firstElementChild?.getAttribute('data-slot')).toBe(
      'flight-spend'
    );
    const spend = list.querySelector('[data-slot=flight-spend] > div');
    // The note is in the cell's hint (srOnly words on the row); the paused verbs keep
    // Stop icon-only.
    expect(spend?.textContent).toBe('Spend$0no ceiling');
    expect(spend?.querySelector(':scope > .srOnly')?.textContent).toBe(
      'no ceiling'
    );
    expect(spend?.hasAttribute('data-hint')).toBe(true);
    expect(screen.getByRole('button', { name: 'Stop' }).textContent).toBe('');
    expect(list.querySelector('[data-slot=flight-waves]')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Agent slots for/ })
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  // Paused, every verb in the header is icon-only (owner decision 2026-11-04), each named
  // and hinted; Raise ceiling… opens the fan-out dialog and gets focus back when it closes.
  test('a paused plan draws Resume and Raise ceiling… icon-only, and Raise ceiling… gets focus back from its dialog', async () => {
    const calls: string[] = [];
    await mount({
      ...dataWith(plan(), [LIVE], [progress('paused', 2)]),
      handleResumeMilestone: (id: string) => {
        calls.push(`resume ${id}`);
        return Promise.resolve();
      },
    } as DispatchProjectData);
    const header = document.querySelector('[data-slot=flight-header]');
    const verbs = ['Resume', 'Raise ceiling…', 'Stop'].map((name) =>
      screen.getByRole('button', { name })
    );
    for (const verb of verbs) {
      expect(header?.contains(verb)).toBe(true);
      expect(verb.textContent).toBe('');
      expect(verb.querySelector('svg')).not.toBeNull();
    }
    const [resume, raise] = verbs;
    if (resume === undefined || raise === undefined)
      throw new Error('no verbs');
    expect(resume.getAttribute('data-slot')).toBe('fanout-resume');
    expect(raise.getAttribute('data-slot')).toBe('fanout-raise');
    // Keyboard focus shows what each does.
    act(() => raise.focus());
    expect(screen.queryByRole('tooltip', { hidden: true })?.textContent).toBe(
      'Raise the fan-out’s spend or run ceiling, then resume it'
    );
    // A press opens the dialog; Cancel closes it and hands focus back to the button.
    await act(async () => {
      fireEvent.click(raise);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = screen.getByRole('dialog', {
      name: 'Raise ceiling · Title e-1',
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(raise);
    await act(async () => {
      fireEvent.click(resume);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toEqual(['resume e-1']);
  });

  // The decision is the Plan header's: a milestone band keeps its worded verbs.
  test('a paused milestone on a project plan keeps its worded verbs', async () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-p' }),
    ];
    await mount(
      dataWith(tasks, [], [progress('paused', 1, 'e-1')]),
      undefined,
      'e-p'
    );
    const band = await milestoneInspector('Alpha');
    const names = Array.from(
      band.querySelectorAll('button'),
      (b) => b.textContent
    );
    expect(names).toContain('Resume');
    expect(names).toContain('Raise ceiling…');
    expect(names).toContain('Stop');
    expect(band.querySelector('[data-slot=fanout-resume]')).toBeNull();
    expect(band.querySelector('[data-slot=fanout-raise]')).toBeNull();
  });

  test('with no fan-out the header has no spend, waves or slots picker', async () => {
    await mount(dataWith(plan()));
    const list = screen.getByRole('list', { name: 'Flight plan' });
    expect(list.querySelector('[data-slot=flight-spend]')).toBeNull();
    expect(list.querySelector('[data-slot=flight-waves]')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Agent slots for/ })
    ).toBeNull();
  });

  test('Send agent is offered only where the server would start the task', async () => {
    await mount(
      dataWith(
        [
          task('e-1', { kind: 'milestone', parent: null }),
          task('e-9', { kind: 'milestone', parent: null }),
          task('t-9', { parent: 'e-9', status: 'working' }),
          task('t-1', { blockedBy: ['t-9'] }),
          task('t-2', { derivedFrom: 'github-pr:7' }),
          task('t-3'),
        ],
        [],
        [progress('active', 4)]
      )
    );
    // Waiting on another milestone's task, and a review anchor: neither.
    fireEvent.click(await card('t-1'));
    expect(sendAgent()).toBeNull();
    fireEvent.click(await card('t-2'));
    expect(sendAgent()).toBeNull();
    fireEvent.click(await card('t-3'));
    expect(sendAgent()).not.toBeNull();
  });
  test('a project session from before plan-wide fan-outs owns only its direct work', async () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-p' }),
    ];
    const legacy = progress('active', 1, 'e-p');
    if (legacy.session !== null) legacy.session.scope = 'direct';
    await mount(dataWith(tasks, [], [legacy]), undefined, 'e-p');
    // The server dispatches only t-2; Alpha may still fan out beside it.
    expect((await milestoneInspector('Alpha')).textContent).toContain(
      'Send agents'
    );
  });

  test('a teammate’s task is theirs: Send agent passes it by', async () => {
    await mount(
      dataWith(
        [
          task('e-1', { kind: 'milestone', parent: null }),
          task('t-1', { assignee: 'human:sam' }),
          task('t-2', { blockedBy: ['t-1'] }),
        ],
        [],
        [progress('active', 2)]
      )
    );
    fireEvent.click(await card('t-1'));
    expect(screen.getByTestId('chart-inspector').textContent).toContain('t-1');
    expect(sendAgent()).toBeNull();
  });
  test('an empty container says what will appear', async () => {
    await mount(
      dataWith([task('e-1', { kind: 'milestone', parent: null })], [])
    );
    expect(screen.getByText('Nothing to plan yet')).toBeTruthy();
  });

  test('a load draws skeletons, and a missing container says it is gone', async () => {
    const { unmount } = await mount({
      ...dataWith(plan()),
      tasksReady: false,
    } as DispatchProjectData);
    // One load, one status: the strip's block is decorative.
    const status = document.querySelectorAll(
      '[data-slot=flight-plan] [role=status]'
    );
    expect(status).toHaveLength(1);
    expect(status[0]?.textContent).toBe('Loading the flight plan');
    expect(document.querySelector('[data-slot=flight-header]')).toBeNull();
    unmount();
    await mount(dataWith(plan()), undefined, 'e-gone');
    expect(screen.getByText('This plan is no longer available.')).toBeTruthy();
    expect(
      screen.getByText('Its container was archived or deleted.')
    ).toBeTruthy();
  });

  test('the section draws from the app’s host, and nothing without one', async () => {
    const { container, unmount } = render(
      <ContainerFlightPlanSection containerId="e-1" />
    );
    expect(container.innerHTML).toBe('');
    unmount();
    render(
      <FlightPlanHostContext.Provider
        value={{
          ...CHART,
          data: dataWith(plan()),
          dispatchTask: () => Promise.resolve(),
          onDispatchFailed: () => {},
          onOpenTask: () => {},
          onPeekTask: () => {},
        }}
      >
        <ContainerFlightPlanSection containerId="e-1" />
      </FlightPlanHostContext.Provider>
    );
    for (const id of ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f']) await card(id);
  });

  test('a send-agents ask from the host opens Send agents once, on its container only', async () => {
    const served: number[] = [];
    const host = (milestoneId: string) => ({
      ...CHART,
      data: dataWith(plan()),
      dispatchTask: () => Promise.resolve(),
      onDispatchFailed: () => {},
      onOpenTask: () => {},
      onPeekTask: () => {},
      sendAgents: { milestoneId, nonce: 7 },
      onSendAgentsServed: (nonce: number) => served.push(nonce),
    });
    const { unmount } = render(
      <FlightPlanHostContext.Provider value={host('e-other')}>
        <ContainerFlightPlanSection containerId="e-1" />
      </FlightPlanHostContext.Provider>
    );
    await settle();
    expect(served).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(
      <FlightPlanHostContext.Provider value={host('e-1')}>
        <ContainerFlightPlanSection containerId="e-1" />
      </FlightPlanHostContext.Provider>
    );
    await settle();
    expect(served).toEqual([7]);
    expect(screen.getByRole('dialog').textContent).toContain('Send agents');
  });
});
