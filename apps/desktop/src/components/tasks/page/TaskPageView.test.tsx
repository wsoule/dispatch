import type {
  ApiClient,
  ConversationQuery,
  Message,
  PlanRecord,
} from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { SavedViewsApi } from '../../../hooks/useSavedViews';
import type { TaskTab } from '../../../lib/appNav';
import { readCriteriaChecks } from '../../../lib/reviewCriteria';
import { linearWorkflowConfig } from '../../settings/fixtures.test-helper';
import { SavedViewsProvider } from '../../shell/SavedViewsContext';
import type { ShellActions } from '../../shell/ShellActionsContext';
import {
  fakeHost,
  type HostLog,
  newLog,
  PageProviders,
  run,
  SHELL,
  task,
} from './pageHost.test-helper';
import type { TaskPageHost } from './TaskPageHost';

// The full task page over a fake host (pageHost.test-helper): @dispatch/ui's TaskDetail
// in its page layout with the lifecycle tabs, the header actions and the rail, each mode
// as the body. The Review mode pulls in the Pierre diff, whose worker import only Vite
// resolves, so it is stubbed before the page is imported.

void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { TaskPageView } = await import('./TaskPageView');

// A ticked criterion is kept per run in localStorage (lib/reviewCriteria.ts),
// so a test that ticks one would otherwise hand it to the next test's run.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const BODY = `## Description

Apply the **Burgess** rule everywhere.

## Acceptance Criteria

- tests pass
- docs updated

## Activity

- 2026-09-13T10:00:00.000Z dispatched (claude, branch dispatch/t-1)
`;

function mount(
  host: TaskPageHost,
  props: Partial<Parameters<typeof TaskPageView>[0]> = {},
  shell: ShellActions = SHELL
) {
  return render(
    <PageProviders host={host} shell={shell}>
      <TaskPageView taskId="t-1" {...props} />
    </PageProviders>
  );
}

function modeOf(): string | null {
  return (
    document
      .querySelector('[data-slot=task-page]')
      ?.getAttribute('data-mode') ?? null
  );
}

/** The lifecycle tab named `label` (NavTabs: a link per stage). */
function tab(label: string): HTMLElement {
  const nav = screen.getByRole('navigation', { name: 'Lifecycle' });
  return within(nav).getByRole('link', { name: new RegExp(`^${label}`) });
}

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true })
    );
  });
}

// A popover positions itself a frame after it mounts; opening or driving one
// runs inside an async act that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

// The fake host's reads that settle at once (the comments, a conversation) land in state a
// few microtasks after a mount, and each re-renders the page (a fresh comment list moves
// its clock, `useTaskDetail`). Waiting out a macrotask inside an async act lets all of them,
// and the renders they cause, finish inside act, so none lands outside it (React's "not
// wrapped in act" warning) while a test reads or acts on the page.
async function settleLoads(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

async function openMoreActions() {
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  });
}

function optionNamed(name: string): HTMLElement {
  const option = screen
    .getAllByRole('option')
    .find(
      (o) =>
        o.textContent === name ||
        o.querySelector('[dir="auto"]')?.textContent === name
    );
  if (option === undefined) {
    throw new Error(
      `no option ${name} among ${screen
        .getAllByRole('option')
        .map((o) => o.textContent)
        .join(', ')}`
    );
  }
  return option;
}

describe('opening a task', () => {
  test('the page is TaskDetail at heading level 1, with the lifecycle tabs and no main of its own', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Title of t-1' })
    ).toBeTruthy();
    expect(screen.getByRole('article').getAttribute('data-layout')).toBe(
      'page'
    );
    const nav = screen.getByRole('navigation', { name: 'Lifecycle' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Spec']);
    expect(tab('Spec').getAttribute('aria-current')).toBe('page');
    expect(modeOf()).toBe('spec');
    // The shell's main is the one main landmark; the page adds none.
    expect(document.querySelectorAll('main')).toHaveLength(0);
    // The body has not arrived: the description holds a skeleton, not a blank page.
    expect(screen.getByText('Loading description')).toBeTruthy();
  });

  test('the body fills the spec when it lands: description, criteria, writes', async () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { writes: ['src/**'] })],
        body: BODY,
      })
    );
    await waitFor(() => expect(screen.getByText('Burgess')).toBeTruthy());
    const criteria = screen.getByRole('region', {
      name: /^Acceptance criteria/,
    });
    expect(within(criteria).getByText('tests pass')).toBeTruthy();
    const writes = screen.getByRole('region', { name: /^Writes/ });
    expect(within(writes).getByText('src/**')).toBeTruthy();
    expect(within(writes).getByLabelText('Add a write path')).toBeTruthy();
    expect(tab('Spec').textContent).toBe('Spec2 criteria · 1 write');
  });

  test('a task that left the list reads as gone, with the way back', () => {
    let back = 0;
    mount(fakeHost(newLog(), { tasks: [] }), {
      onBack: () => {
        back++;
      },
    });
    expect(screen.getByText(/^No task .* in this project\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(back).toBe(1);
  });

  test('embedded, the title is a level-2 heading and Expand opens the full page', () => {
    let expanded = 0;
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), {
      embedded: true,
      headingLevel: 2,
      onExpand: () => {
        expanded++;
      },
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Title of t-1' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the full page' }));
    expect(expanded).toBe(1);
  });
});

describe('the mode follows the task', () => {
  test('a live run opens on the run', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'working' })],
        runs: [run()],
      })
    );
    expect(modeOf()).toBe('run');
    expect(document.querySelector('[data-slot=run-strip]')).not.toBeNull();
    expect(tab('Run').getAttribute('aria-current')).toBe('page');
    // Run mode draws the strip itself, so the rail's Work section does not repeat it.
    expect(document.querySelectorAll('[data-slot=run-strip]')).toHaveLength(1);
    // The spec's sections are not on a run page.
    expect(screen.queryByRole('heading', { name: 'Description' })).toBeNull();
  });

  test('a finished run opens on its review', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [run({ state: 'finished', costUsd: 0.42 })],
      })
    );
    expect(modeOf()).toBe('review');
    expect(screen.getByRole('button', { name: /^Land/ })).toBeTruthy();
    expect(tab('Review').textContent).toBe('ReviewWaiting on you');
  });

  test('the review’s criteria tick as checkboxes, kept per run', async () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [run({ state: 'finished' })],
        body: BODY,
      })
    );
    const list = await screen.findByRole('list', {
      name: 'Acceptance criteria',
    });
    const box = within(list).getByRole('checkbox', { name: 'tests pass' });
    expect((box as HTMLInputElement).checked).toBe(false);
    act(() => {
      fireEvent.click(box);
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect([...readCriteriaChecks('r-1')]).toEqual([0]);
    act(() => {
      fireEvent.click(box);
    });
    expect(readCriteriaChecks('r-1').size).toBe(0);
  });

  test('a ticked criterion keeps the page’s keys: s from its checkbox opens the status picker', async () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [run({ state: 'finished' })],
        body: BODY,
      })
    );
    const list = await screen.findByRole('list', {
      name: 'Acceptance criteria',
    });
    const box = within(list).getByRole('checkbox', { name: 'tests pass' });
    act(() => {
      box.focus();
      fireEvent.click(box);
    });
    expect(document.activeElement).toBe(box);
    await settle(() => {
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', bubbles: true })
      );
    });
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });

  test('review and summary skip the verify and fix-loop reads a task cannot have yet', async () => {
    const asked: string[] = [];
    const client = {
      fetchTaskVerification: (id: string) => {
        asked.push(`verification ${id}`);
        return Promise.resolve(null);
      },
      fetchFixLoop: (id: string) => {
        asked.push(`fix-loop ${id}`);
        return Promise.resolve(null);
      },
    } as unknown as Partial<ApiClient>;
    // A finished execute run and no verify run: the fix loop may exist, a verify
    // result cannot.
    const view = mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [run({ state: 'finished' })],
        client,
      })
    );
    await settleLoads();
    expect(modeOf()).toBe('review');
    await waitFor(() => expect(asked).toEqual(['fix-loop t-1']));
    // Settled: no verify read follows.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(asked).toEqual(['fix-loop t-1']);
    view.unmount();
    // Once a verify run has ended, its result is read too.
    asked.length = 0;
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [
          run({ state: 'finished' }),
          run({ id: 'r-v', kind: 'verify', state: 'finished' }),
        ],
        client,
      })
    );
    await settleLoads();
    await waitFor(() =>
      expect([...asked].sort()).toEqual(['fix-loop t-1', 'verification t-1'])
    );
  });

  test('landed work opens on its summary', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'landed' })],
        runs: [
          run({
            state: 'finished',
            reviewedAt: '2026-09-23T11:00:00.000Z',
            reviewAction: 'merge',
            mergeCommit: 'abc1234def',
            landsOn: 'origin',
            pushedToOrigin: true,
          }),
        ],
      })
    );
    expect(modeOf()).toBe('summary');
    expect(screen.getByText('Landed on origin/main')).toBeTruthy();
  });

  test('a container opens on its plan, where the rail leaves its sub-issues out', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [
          task('t-1', { kind: 'milestone', status: 'working' }),
          task('t-2', { parent: 't-1' }),
        ],
      })
    );
    expect(modeOf()).toBe('plan');
    expect(document.querySelector('[data-slot=plan-mode]')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: /^Sub-issues/ })).toBeNull();
    expect(tab('Plan').textContent).toBe('Plan0/1 done');
  });

  test('a container’s spec lists its sub-issues in the rail, with a way to add one and the plan', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [
          task('t-1', { kind: 'milestone', status: 'working' }),
          task('t-2', { parent: 't-1', priority: 'high' }),
        ],
      })
    );
    fireEvent.click(tab('Spec'));
    expect(modeOf()).toBe('spec');
    const section = screen.getByRole('region', { name: /^Sub-issues/ });
    expect(within(section).getByText('Title of t-2')).toBeTruthy();
    // One heading carries the title and the progress: the block's fold button sits
    // inside the section's heading (no second "Sub-issues" above it), and a press on
    // its words folds the list.
    const headings = screen.getAllByRole('heading', { name: /^Sub-issues/ });
    expect(headings).toHaveLength(1);
    const fold = within(section).getByRole('button', {
      name: 'Sub-issues 0 of 1 done',
    });
    expect(headings[0]?.contains(fold)).toBe(true);
    expect(within(section).getAllByText('Sub-issues')).toHaveLength(1);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    // The priority glyph is aria-hidden; the row says the priority in words.
    expect(within(section).getByText('High')).toBeTruthy();
    fireEvent.click(within(fold).getByText('Sub-issues'));
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(within(section).queryByText('Title of t-2')).toBeNull();
    fireEvent.click(fold);
    expect(within(section).getByText('Title of t-2')).toBeTruthy();
    expect(
      within(section).getByRole('button', {
        name: 'Add sub-task to Title of t-1',
      })
    ).toBeTruthy();
    // A container fans out from its plan, never as one run of its own.
    expect(document.querySelector('[data-slot=dispatch-card]')).toBeNull();
    fireEvent.click(
      within(section).getByRole('button', { name: 'Open the plan' })
    );
    expect(modeOf()).toBe('plan');
  });

  test('a mirrored workflow’s finished container reads config’s statuses before the open project’s model is set', () => {
    const host = fakeHost(newLog(), {
      tasks: [
        task('t-1', { kind: 'milestone', status: 'Done' }),
        task('t-2', { parent: 't-1', status: 'Done' }),
        task('t-3', { parent: 't-1', status: 'Canceled' }),
      ],
    });
    mount({
      ...host,
      project: { ...host.project, config: linearWorkflowConfig },
    });
    expect(modeOf()).toBe('summary');
    expect(
      document.querySelector('[data-slot=summary-mode]')?.textContent
    ).toContain('1 of 2 sub-issues landed · 1 dropped');
  });

  test('a stage picked by hand holds; picking the state’s own follows again', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1')],
        runs: [run({ state: 'finished' })],
      })
    );
    fireEvent.click(tab('Summary'));
    expect(modeOf()).toBe('summary');
    fireEvent.click(tab('Spec'));
    expect(modeOf()).toBe('spec');
  });

  test('the caller keeps the mode, as auto when it follows the state', () => {
    const changes: TaskTab[] = [];
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1')],
        runs: [run({ state: 'finished' })],
      }),
      {
        mode: 'auto',
        onModeChange: (next) => changes.push(next),
      }
    );
    fireEvent.click(tab('Review'));
    fireEvent.click(tab('Spec'));
    expect(changes).toEqual(['review', 'auto']);
  });

  test('before any run, a link to the Run tab lands on the spec', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), { mode: 'run' });
    expect(modeOf()).toBe('spec');
    expect(screen.queryByRole('link', { name: /^Run/ })).toBeNull();
  });
});

describe('the conversation', () => {
  function hostWithThreads(): TaskPageHost {
    return {
      ...fakeHost(newLog(), { tasks: [task('t-1')] }),
      threadView: (taskId) => <p>threads of {taskId}</p>,
    };
  }

  test('the toggle shows the task’s conversation with its unread count, and again returns to the state', () => {
    mount(hostWithThreads(), { conversationCount: 2 });
    const toggle = screen.getByRole('button', { name: 'Conversation · 2' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(modeOf()).toBe('thread');
    expect(screen.getByText('threads of t-1')).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // No stage is current while a side view shows.
    expect(tab('Spec').getAttribute('aria-current')).toBeNull();
    fireEvent.click(toggle);
    expect(modeOf()).toBe('spec');
  });

  test('the caller keeps the thread mode', () => {
    const changes: TaskTab[] = [];
    mount(hostWithThreads(), {
      mode: 'auto',
      onModeChange: (next) => changes.push(next),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    expect(changes).toEqual(['thread']);
  });

  test('no toggle, and a thread mode falls back to the state, without a thread view', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), { mode: 'thread' });
    expect(screen.queryByRole('button', { name: /Conversation/ })).toBeNull();
    expect(modeOf()).toBe('spec');
  });
});

describe('header actions', () => {
  test('Close leaves the page', () => {
    let back = 0;
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), {
      onBack: () => {
        back++;
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(back).toBe(1);
    // Expand is the embedded page's alone.
    expect(
      screen.queryByRole('button', { name: 'Open the full page' })
    ).toBeNull();
  });

  test('the menu copies the id, archives and drops through the host', async () => {
    const log = newLog();
    const copied: string[] = [];
    mount(
      fakeHost(log, { tasks: [task('t-1')] }),
      {},
      {
        ...SHELL,
        copyTaskId: (id) => copied.push(id),
      }
    );
    await openMoreActions();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Copy id',
      'Dispatch',
      'Archive',
      'Drop',
    ]);
    await settle(() => fireEvent.click(optionNamed('Copy id')));
    expect(copied).toEqual(['t-1']);
    await openMoreActions();
    await settle(() => fireEvent.click(optionNamed('Archive')));
    await waitFor(() => expect(log.updates).toHaveLength(1));
    expect(log.updates[0]?.patch.archivedAt).toBeString();
    await openMoreActions();
    await settle(() => fireEvent.click(optionNamed('Drop')));
    await waitFor(() =>
      expect(log.moves).toEqual([{ id: 't-1', status: 'dropped' }])
    );
  });

  test('no star without a saved-views provider', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    expect(screen.queryByRole('button', { name: /Favorite/ })).toBeNull();
  });
});

// A `ResizeObserver` stand-in that records each observer's callback, so a test can
// replay the page's measurement at a width of its choosing without a layout engine.
function fakeResizeObservers() {
  const Original = globalThis.ResizeObserver;
  const callbacks: ResizeObserverCallback[] = [];
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  return {
    // Gives the page's frame this width and fires every observer, as a resize would.
    resizeTo(width: number) {
      const root = document.querySelector('[data-slot=task-page]');
      if (root === null) throw new Error('no task page');
      Object.defineProperty(root, 'clientWidth', {
        configurable: true,
        get: () => width,
      });
      act(() => {
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });
    },
    restore() {
      globalThis.ResizeObserver = Original;
    },
  };
}

describe('the header actions', () => {
  const SIDE_VIEWS = [
    "Show the run's files",
    "Open a terminal in the run's worktree",
    "Preview the run's app",
  ];

  // A finished run with every side view the host can offer, and a starred task.
  function mountWithToggles(toggled: unknown[]) {
    const host: TaskPageHost = {
      ...fakeHost(newLog(), {
        tasks: [task('t-1')],
        runs: [run({ state: 'finished' })],
      }),
      filesView: () => <p>the files</p>,
      terminalView: () => <p>the terminal</p>,
    };
    const savedViews = {
      isFavorite: () => true,
      toggleFavorite: (ref: unknown) => toggled.push(ref),
    } as unknown as SavedViewsApi;
    return render(
      <PageProviders host={host}>
        <SavedViewsProvider value={savedViews}>
          <TaskPageView taskId="t-1" />
        </SavedViewsProvider>
      </PageProviders>
    );
  }

  test('wide, the header keeps the star, More actions and close; the side views are menu rows', async () => {
    const observers = fakeResizeObservers();
    try {
      mountWithToggles([]);
      await settleLoads();
      observers.resizeTo(1200);
      expect(screen.getByRole('button', { name: 'Unfavorite' })).toBeTruthy();
      for (const name of SIDE_VIEWS) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      // Every icon button names itself with a library tooltip on focus.
      const star = screen.getByRole('button', { name: 'Unfavorite' });
      act(() => star.focus());
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(
        'Unfavorite'
      );
      await openMoreActions();
      const names = screen.getAllByRole('option').map((o) => o.textContent);
      for (const name of SIDE_VIEWS) expect(names).toContain(name);
      expect(names).not.toContain('Favorite');
      expect(names).not.toContain('Unfavorite');
    } finally {
      observers.restore();
    }
  });

  test('under 480px the star moves into More actions too, and comes back when it widens', async () => {
    const observers = fakeResizeObservers();
    const toggled: unknown[] = [];
    try {
      mountWithToggles(toggled);
      // The Overseer's focus column: about 330px.
      observers.resizeTo(330);
      expect(screen.queryByRole('button', { name: 'Unfavorite' })).toBeNull();
      expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();

      await openMoreActions();
      // Starred: the row says what it does, as the wide button does.
      for (const name of [...SIDE_VIEWS, 'Unfavorite']) {
        expect(optionNamed(name)).toBeTruthy();
      }
      // No toggle is drawn ticked (the keyboard would start on it).
      for (const option of screen.getAllByRole('option')) {
        expect(option.getAttribute('aria-selected')).not.toBe('true');
      }
      await settle(() => fireEvent.click(optionNamed("Show the run's files")));
      expect(modeOf()).toBe('files');
      await openMoreActions();
      expect(optionNamed("Hide the run's files")).toBeTruthy();
      await settle(() => fireEvent.click(optionNamed('Unfavorite')));
      expect(toggled).toEqual([{ kind: 'task', id: 't-1' }]);

      // A frame not laid out (a hidden Activity) keeps the narrow header.
      observers.resizeTo(0);
      expect(screen.queryByRole('button', { name: 'Unfavorite' })).toBeNull();

      observers.resizeTo(1200);
      expect(screen.getByRole('button', { name: 'Unfavorite' })).toBeTruthy();
    } finally {
      observers.restore();
    }
  });

  test('narrow and starred, More actions opened from the keyboard starts on its first row', async () => {
    const observers = fakeResizeObservers();
    const toggled: unknown[] = [];
    try {
      mountWithToggles(toggled);
      observers.resizeTo(330);
      const trigger = screen.getByRole('button', { name: 'More actions' });
      act(() => trigger.focus());
      await settle(() => fireEvent.keyDown(trigger, { key: 'ArrowDown' }));
      const menu = await screen.findByRole('listbox');
      const active = menu.getAttribute('aria-activedescendant');
      expect(active).not.toBeNull();
      expect(document.getElementById(active ?? '')?.textContent).toBe(
        'Copy id'
      );
      // Enter on it copies the id; the task stays starred.
      await settle(() => fireEvent.keyDown(menu, { key: 'Enter' }));
      expect(toggled).toEqual([]);
    } finally {
      observers.restore();
    }
  });

  test('the threshold is the header’s width: the frame less the pane’s 32px gutters', () => {
    const observers = fakeResizeObservers();
    try {
      mountWithToggles([]);
      observers.resizeTo(512);
      expect(screen.getByRole('button', { name: 'Unfavorite' })).toBeTruthy();
      observers.resizeTo(511);
      expect(screen.queryByRole('button', { name: 'Unfavorite' })).toBeNull();
    } finally {
      observers.restore();
    }
  });
});

describe('dispatching', () => {
  test('the card sits in the rail’s Work section and dispatches without leaving the page', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1', { writes: ['src/**'] })] }));
    await settleLoads();
    const work = screen.getByRole('region', { name: 'Work' });
    fireEvent.click(within(work).getByRole('button', { name: /^Dispatch/ }));
    await waitFor(() =>
      expect(log.dispatches).toEqual([{ taskId: 't-1', stayInPlace: false }])
    );
    expect(screen.getByText('Starting an agent…')).toBeTruthy();
  });

  test('embedded, a dispatch stays in place', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1')] }), { embedded: true });
    await settleLoads();
    press('d');
    await waitFor(() => expect(log.dispatches).toHaveLength(1));
    expect(log.dispatches[0]?.stayInPlace).toBe(true);
  });

  test('d dispatches a ready task from anywhere on the page, never ahead of blockers', async () => {
    const log = newLog();
    const view = mount(fakeHost(log, { tasks: [task('t-1')] }));
    await settleLoads();
    press('d');
    await waitFor(() => expect(log.dispatches).toHaveLength(1));
    view.unmount();
    cleanup();
    const blocked = newLog();
    mount(
      fakeHost(blocked, {
        tasks: [task('t-1', { blockedBy: ['t-2'] }), task('t-2')],
      })
    );
    await settleLoads();
    expect(screen.getByRole('button', { name: /^Dispatch/ }).textContent).toBe(
      'Dispatch anyway'
    );
    press('d');
    expect(blocked.dispatches).toEqual([]);
    await openMoreActions();
    expect(optionNamed('Dispatch anyway')).toBeTruthy();
  });

  test('a landed task says to reopen it, and nothing dispatches it', () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1', { status: 'landed' })] }));
    fireEvent.click(tab('Spec'));
    expect(screen.getByText('Closed: reopen it to dispatch')).toBeTruthy();
    press('d');
    expect(log.dispatches).toEqual([]);
  });

  test('a failed run’s alert opens the run', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'working' })],
        runs: [run({ state: 'failed' })],
      })
    );
    fireEvent.click(tab('Spec'));
    expect(modeOf()).toBe('spec');
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }));
    expect(modeOf()).toBe('run');
  });
});

describe('keyboard', () => {
  test('s opens the status picker; a key typed into a field is left alone', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    const field = screen.getByLabelText('Due date');
    fireEvent.keyDown(field, { key: 's' });
    expect(screen.queryByRole('listbox')).toBeNull();
    await settle(() => press('s'));
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });

  test('a key typed inside a dialog on the page (an open popover) is left alone', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    // A popover's panel, as the library Popover draws it: role="dialog" inside the page.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inside = document.createElement('button');
    dialog.append(inside);
    document.querySelector('[data-slot=task-page]')?.append(dialog);
    await settle(() => {
      inside.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', bubbles: true })
      );
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    dialog.remove();
    await settle(() => press('s'));
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });
});

describe('the rail', () => {
  test('property edits go through the host', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1')] }));
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Assignee: / }));
    });
    await settle(() => {
      fireEvent.click(optionNamed('Any agent'));
    });
    expect(log.updates).toEqual([{ id: 't-1', patch: { assignee: 'agent' } }]);
  });

  test('the Work section leads to the latest run from its strip and shows the pull request', () => {
    const finished = run({
      state: 'finished',
      prUrl: 'https://github.com/acme/app/pull/7',
    });
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [finished],
      }),
      { mode: 'spec' }
    );
    const work = screen.getByRole('region', { name: 'Work' });
    expect(work.querySelector('[data-slot=run-strip]')).not.toBeNull();
    const links = screen.getByRole('region', { name: 'Links' });
    expect(
      within(links)
        .getByRole('link', { name: /Pull request/ })
        .getAttribute('href')
    ).toBe('https://github.com/acme/app/pull/7');
  });

  test("shows where a task's run is live on the team and whom it waits on", async () => {
    const getTaskPresence = () =>
      Promise.resolve({
        presence: { replica: 'bob-0000000b', handle: 'bob', device: 'desk' },
        waitingOn: 'ada',
      });
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1')],
        body: BODY,
        client: {
          getTaskPresence,
          getTeamStatus: () =>
            Promise.resolve({ state: 'member' } as Awaited<
              ReturnType<ApiClient['getTeamStatus']>
            >),
        } as Partial<ApiClient>,
      })
    );
    expect(
      await screen.findByText("Running on bob's desk, waiting on ada")
    ).toBeTruthy();
  });
});

describe('a request-tier window', () => {
  test('reads only: no editors, no writes in the menu, and the writes as text', async () => {
    const log: HostLog = newLog();
    mount(
      fakeHost(log, {
        tasks: [task('t-1', { writes: ['src/**'] })],
        body: BODY,
        project: { myTier: 'request' },
      })
    );
    expect(screen.queryByRole('button', { name: 'Title of t-1' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Status: / })).toBeNull();
    expect(document.querySelector('[data-slot=dispatch-card]')).toBeNull();
    await waitFor(() => expect(screen.getByText('Burgess')).toBeTruthy());
    expect(screen.queryByLabelText('Add a write path')).toBeNull();
    expect(screen.getByText('src/**')).toBeTruthy();
    // s opens nothing for a window that may not write.
    await settle(() => press('s'));
    expect(screen.queryByRole('listbox')).toBeNull();
    await openMoreActions();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Copy id',
    ]);
  });
});

// A message about t-1, with the fields the rail reads.
function a2aMessage(over: Partial<Message>): Message {
  return {
    id: 'm-1',
    thread: 'th-1',
    replyTo: null,
    from: 'run:r-1',
    to: ['task:t-1'],
    kind: 'message',
    body: 'hi',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-10-29T10:00:00.000Z',
    ...over,
  };
}

function mountWithConversation(
  messages: Message[],
  { canMessage = true }: { canMessage?: boolean } = {}
) {
  const asked: ConversationQuery[] = [];
  mount(
    fakeHost(newLog(), {
      tasks: [task('t-1')],
      client: {
        getConversation: (query) => {
          asked.push(query);
          return Promise.resolve({ messages, next: null });
        },
      },
      project: {
        messageAccess: { canDecide: true, canMessage, explanation: null },
      },
    })
  );
  return asked;
}

describe('TaskPageView outside agents', () => {
  test("lists each outside agent in the task's conversation with what's waiting", async () => {
    const asked = mountWithConversation([
      a2aMessage({ id: 'q1', kind: 'question', to: ['a2a:acme-billing'] }),
      a2aMessage({
        id: 'q2',
        kind: 'question',
        from: 'agent:wyat/a2a.ci-bot',
        to: ['task:t-1'],
      }),
    ]);
    expect(await screen.findByText('Outside agents')).toBeDefined();
    const summaryEls = Array.from(
      document.querySelectorAll('[data-slot=outside-agent-summary]')
    );
    // The agent waiting on you comes first.
    expect(summaryEls.map((el) => el.textContent)).toEqual([
      'Waiting on you · 1 question',
      'Waiting on them · 1 question',
    ]);
    // Waiting on you is missing input: the warning tone's text, not a raw hue. data-waiting
    // stays as the state hook (the tone is only its colour).
    const [waiting, notWaiting] = summaryEls;
    expect(waiting?.getAttribute('data-waiting')).toBe('true');
    expect(waiting?.getAttribute('data-tone')).toBe('warning');
    expect(waiting?.classList.contains('toneText')).toBe(true);
    expect(notWaiting?.hasAttribute('data-waiting')).toBe(false);
    expect(notWaiting?.hasAttribute('data-tone')).toBe(false);
    expect(notWaiting?.classList.contains('toneText')).toBe(false);
    expect(asked[0]).toMatchObject({ about: 'task:t-1' });
  });

  test('a task no outside agent has talked to shows no section', async () => {
    mountWithConversation([a2aMessage({ from: 'human:wyat' })]);
    await settleLoads();
    expect(document.querySelector('[data-slot=outside-agents]')).toBeNull();
  });

  test('without messaging access the rail never asks for the conversation', async () => {
    const asked = mountWithConversation(
      [a2aMessage({ kind: 'question', to: ['a2a:acme-billing'] })],
      { canMessage: false }
    );
    await settleLoads();
    expect(asked).toEqual([]);
    expect(document.querySelector('[data-slot=outside-agents]')).toBeNull();
  });
});

describe('TaskPageView enrich error', () => {
  test('a failed "Add detail" pass reads in the danger tone, not a raw hue', () => {
    const failed: PlanRecord = {
      id: 'pl-1',
      prompt: 'add detail',
      plannerName: 'claude',
      role: 'enrich',
      state: 'failed',
      error: 'the planner timed out',
      messages: [],
      questions: [],
      createdAt: '2026-10-29T10:00:00.000Z',
      updatedAt: '2026-10-29T10:00:00.000Z',
    };
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1')],
        project: { enrichTaskId: 't-1', enrichPlanRecord: failed },
      })
    );
    const error = screen.getByText('the planner timed out');
    expect(error.getAttribute('data-tone')).toBe('danger');
    expect(error.classList.contains('toneText')).toBe(true);
  });
});
