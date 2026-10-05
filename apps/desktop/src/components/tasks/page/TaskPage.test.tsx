import type { ApiClient, LedgerEntry } from '@dispatch/client';
import type { TaskComment } from '@dispatch/core/browser';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { TaskTab } from '../../../lib/appNav';
import { entry as memoryEntry } from '../../../lib/memory.test-helper';
import { linearWorkflowConfig } from '../../settings/fixtures.test-helper';
import {
  fakeHost,
  newLog,
  PageProviders,
  run,
  task,
} from './pageHost.test-helper';
import type { TaskPageHost } from './TaskPageHost';

// The Review mode pulls in the Pierre diff, whose worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { TaskPage } = await import('./TaskPage');

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
  props: Partial<Parameters<typeof TaskPage>[0]> = {}
) {
  return render(
    <PageProviders host={host}>
      <TaskPage taskId="t-1" layout="peek" {...props} />
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

function comment(
  id: string,
  author: string,
  body: string,
  parentId: string | null = null
): TaskComment {
  return {
    id,
    taskId: 't-1',
    author,
    body,
    created: '2026-09-23T10:00:00.000Z',
    updated: '2026-09-23T10:00:00.000Z',
    parentId,
    external: null,
  };
}

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true })
    );
  });
}

// Opens the header's More actions menu and lets its popup settle inside act.
async function openMoreActions() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('opening a task', () => {
  test('metadata renders at once; the body streams in behind skeletons', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    // Title and the lifecycle track straight from the cached list.
    expect(screen.getByLabelText('Task title')).toHaveProperty(
      'value',
      'Title of t-1'
    );
    expect(screen.getByRole('tablist', { name: 'Task stages' })).not.toBeNull();
    expect(modeOf()).toBe('spec');
    // The body has not arrived: its sections hold skeletons, not a blank page.
    expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0);
  });

  test('the body fills the spec when it lands', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')], body: BODY }));
    await waitFor(() => expect(screen.getByText('tests pass')).not.toBeNull());
    expect(screen.getByText('docs updated')).not.toBeNull();
    expect(screen.getByText('Burgess')).not.toBeNull();
  });

  test('a task that left the list reads as gone', () => {
    mount(fakeHost(newLog(), { tasks: [] }));
    expect(
      screen.getByText('That task is no longer available.')
    ).not.toBeNull();
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
  });

  test('a finished run opens on its review', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'review' })],
        runs: [run({ state: 'finished', costUsd: 0.42 })],
      })
    );
    expect(modeOf()).toBe('review');
    expect(screen.getByRole('button', { name: /^Land/ })).not.toBeNull();
  });

  test('a live run’s review offers no verdict until it finishes', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'working' })],
        runs: [run()],
      })
    );
    fireEvent.click(screen.getByRole('tab', { name: /Review/ }));
    expect(modeOf()).toBe('review');
    expect(screen.queryByRole('button', { name: /^Land/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'More ways to land' })
    ).toBeNull();
    expect(screen.getByText('Lands once it finishes')).not.toBeNull();
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
          }),
        ],
      })
    );
    expect(modeOf()).toBe('summary');
    expect(screen.getByText('Merged into main')).not.toBeNull();
    expect(screen.getByText('abc1234')).not.toBeNull();
  });

  // Lessons live in memory now: the summary lists what reaches the task under
  // Memory, and reads only the ledger's audit class for its Receipts.
  test('the summary splits the ledger into the memory that reaches the task and its receipts', async () => {
    const reads = { ledger: [] as unknown[], memory: [] as unknown[] };
    const ledger: LedgerEntry[] = [
      {
        id: 'l-000001',
        epicId: null,
        sourceTaskId: 't-1',
        kind: 'decision',
        title: 'Scope extended for run r-x',
        detail: 'src/x.ts — needed',
        appliesTo: [],
        authoredBy: 'human:x',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ];
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'landed' })],
        runs: [run({ state: 'finished' })],
        client: {
          fetchLedger: (filter: unknown) => {
            reads.ledger.push(filter);
            return Promise.resolve(ledger);
          },
          listMemory: (q: unknown) => {
            reads.memory.push(q);
            return Promise.resolve({
              entries: [memoryEntry({ title: 'pnpm builds' })],
            });
          },
        } as Partial<ApiClient>,
      })
    );
    expect(modeOf()).toBe('summary');
    expect(await screen.findByText('pnpm builds')).not.toBeNull();
    expect(
      await screen.findByText('Scope extended for run r-x')
    ).not.toBeNull();
    expect(screen.getByText('Receipts')).not.toBeNull();
    expect(screen.queryByText('Ledger')).toBeNull();
    expect(reads.ledger).toEqual([{ epicId: null, class: 'audit' }]);
    expect(reads.memory).toEqual([{ taskId: 't-1', limit: 200 }]);
  });

  test('a task reopened after it landed opens on its spec, with Dispatch', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { status: 'ready' })],
        runs: [
          run({
            state: 'finished',
            reviewedAt: '2026-09-23T11:00:00.000Z',
            reviewAction: 'merge',
            mergeCommit: 'abc1234def',
          }),
        ],
      })
    );
    expect(modeOf()).toBe('spec');
    expect(document.querySelector('[data-slot=dispatch-card]')).not.toBeNull();
  });

  test('a landed container’s summary rolls up its sub-issues’ work', () => {
    const log = newLog();
    mount(
      fakeHost(log, {
        tasks: [
          task('t-1', { kind: 'milestone', status: 'landed' }),
          task('t-2', { parent: 't-1', status: 'landed' }),
          task('t-3', { parent: 't-1', status: 'dropped' }),
        ],
        runs: [
          run({
            id: 'r-2',
            taskId: 't-2',
            state: 'finished',
            reviewedAt: '2026-09-23T11:00:00.000Z',
            reviewAction: 'merge',
            mergeCommit: 'bd7298eaaa',
            costUsd: 0.25,
          }),
        ],
      })
    );
    expect(modeOf()).toBe('summary');
    const summary = document.querySelector('[data-slot=summary-mode]');
    expect(summary?.textContent).toContain(
      '1 of 2 sub-issues landed · 1 dropped'
    );
    expect(summary?.textContent).not.toContain('without an agent run');
    expect(screen.getByText('bd7298e')).not.toBeNull();
    expect(screen.getByText('$0.25')).not.toBeNull();
    const outcomes = document.querySelector<HTMLElement>(
      '[data-slot=sub-issue-outcomes]'
    );
    if (outcomes === null) throw new Error('no sub-issue outcomes');
    fireEvent.click(within(outcomes).getByText('Title of t-3'));
    expect(log.peeks).toEqual(['t-3']);
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

  test('a container opens on its plan, where the Flight Plan draws every sub-issue', () => {
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
    // The plan is the list, so the rail leaves its sub-issue excerpt out.
    expect(screen.queryByText('Sub-issues')).toBeNull();
  });

  test('a container’s spec lists its sub-issues once, with a way to add one', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [
          task('t-1', { kind: 'milestone', status: 'working' }),
          task('t-2', { parent: 't-1' }),
        ],
      })
    );
    fireEvent.click(screen.getByRole('tab', { name: /Spec/ }));
    expect(modeOf()).toBe('spec');
    expect(screen.getAllByText('Sub-issues')).toHaveLength(1);
    expect(screen.getByText('Title of t-2')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Add sub-task to Title of t-1' })
    ).not.toBeNull();
    // A container fans out from its plan, never as one run of its own.
    expect(document.querySelector('[data-slot=dispatch-card]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    expect(modeOf()).toBe('plan');
  });

  test('a stage picked by hand holds; picking the state’s own follows again', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    fireEvent.click(screen.getByRole('tab', { name: /Summary/ }));
    expect(modeOf()).toBe('summary');
    fireEvent.click(screen.getByRole('tab', { name: /Spec/ }));
    expect(modeOf()).toBe('spec');
  });

  test('the full page keeps its mode in the caller, as auto when it follows state', () => {
    const changes: TaskTab[] = [];
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), {
      layout: 'full',
      mode: 'auto',
      onModeChange: (tab) => changes.push(tab),
    });
    fireEvent.click(screen.getByRole('tab', { name: /Review/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Spec/ }));
    expect(changes).toEqual(['review', 'auto']);
  });
});

describe('opening a run by id', () => {
  // An execute run that finished, and the review agent that is checking it.
  const runs = [
    run({ id: 'r-exec', state: 'finished' }),
    run({
      id: 'r-review',
      kind: 'review',
      branch: 'dispatch/review-t-1-review',
      baseBranch: 'dispatch/t-1',
      createdAt: '2026-09-23T11:00:00.000Z',
    }),
  ];
  function hostFetching(fetched: string[]) {
    return fakeHost(newLog(), {
      tasks: [task('t-1', { status: 'review' })],
      runs,
      client: {
        fetchRun: (id: string) => {
          fetched.push(id);
          return new Promise(() => {});
        },
      },
    });
  }

  test('a review agent’s run shows its own transcript, named by kind', async () => {
    const fetched: string[] = [];
    mount(hostFetching(fetched), {
      layout: 'full',
      mode: 'run',
      runId: 'r-review',
    });
    await waitFor(() => expect(fetched).toEqual(['r-review']));
    const strip = document.querySelector('[data-slot=run-strip]');
    expect(strip?.textContent).toContain('r-review');
    expect(strip?.textContent).toContain('Review');
  });

  test('Review mode judges the work a picked review run checked', async () => {
    const fetched: string[] = [];
    mount(hostFetching(fetched), {
      layout: 'full',
      mode: 'review',
      runId: 'r-review',
    });
    await waitFor(() => expect(fetched).toEqual(['r-exec']));
    expect(
      document.querySelector('[data-slot=run-strip]')?.textContent
    ).toContain('r-exec');
  });
});

describe('dispatching from the spec', () => {
  test('Dispatch sends the task and keeps a split pane where it is', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1', { writes: ['src/**'] })] }), {
      layout: 'split',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch/ }));
    await waitFor(() =>
      expect(log.dispatches).toEqual([{ taskId: 't-1', stayInPlace: true }])
    );
    expect(screen.getByText('Starting an agent…')).not.toBeNull();
  });

  test('unmet blockers are named and the button asks to go anyway', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { blockedBy: ['t-2'] }), task('t-2')],
      })
    );
    expect(
      document.querySelector('[data-check=blockers]')?.textContent
    ).toContain('Waits on 1 task');
    expect(
      screen.getByRole('button', { name: /Dispatch anyway/ })
    ).not.toBeNull();
  });

  test('a blocker id naming no task does not hold the task back', () => {
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1', { blockedBy: ['t-gone'], writes: ['src/**'] })],
        body: BODY,
      })
    );
    expect(
      document.querySelector('[data-check=blockers]')?.getAttribute('data-tone')
    ).toBe('warn');
    expect(screen.queryByText('Waiting on its blockers')).toBeNull();
    expect(screen.getByRole('button', { name: /^Dispatch/ }).textContent).toBe(
      'DispatchD'
    );
  });

  test('a landed task says to reopen it, and nothing dispatches it', () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1', { status: 'landed' })] }), {
      layout: 'full',
    });
    fireEvent.click(screen.getByRole('tab', { name: /Spec/ }));
    expect(screen.getByText('Closed: reopen it to dispatch')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Dispatch/ })).toHaveProperty(
      'disabled',
      true
    );
    // A dispatch reaches the host synchronously, so none by now means none at all.
    press('d');
    expect(log.dispatches).toEqual([]);
  });

  test('a dropped task’s menu offers no dispatch', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1', { status: 'dropped' })] }));
    await openMoreActions();
    const item = screen.getByRole('menuitem', { name: /Dispatch/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
  });

  test('d goes whenever the card offers D: a blocker in review is met', async () => {
    const log = newLog();
    mount(
      fakeHost(log, {
        tasks: [
          task('t-1', { blockedBy: ['t-2'] }),
          task('t-2', { status: 'review' }),
        ],
      }),
      { layout: 'full' }
    );
    expect(
      document.querySelector('[data-check=blockers]')?.textContent
    ).toContain('Blockers done');
    expect(screen.getByRole('button', { name: /^Dispatch/ }).textContent).toBe(
      'DispatchD'
    );
    press('d');
    await waitFor(() => expect(log.dispatches).toHaveLength(1));
  });

  test('d never goes ahead of blockers, and the card shows no D for it', async () => {
    const log = newLog();
    mount(
      fakeHost(log, {
        tasks: [task('t-1', { blockedBy: ['t-2'] }), task('t-2')],
      }),
      { layout: 'full' }
    );
    expect(screen.getByRole('button', { name: /^Dispatch/ }).textContent).toBe(
      'Dispatch anyway'
    );
    press('d');
    expect(log.dispatches).toEqual([]);
    // The header menu offers the same deliberate go-ahead as the card.
    await openMoreActions();
    const item = screen.getByRole('menuitem', { name: /Dispatch anyway/ });
    expect(item.getAttribute('aria-disabled')).toBeNull();
  });

  test('the effort picker sends nothing by default and the level picked', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1')] }), { layout: 'full' });
    const picker = screen.getByRole('button', { name: 'Effort' });
    expect(picker.textContent).toBe('Default');
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Max' }));
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch/ }));
    await waitFor(() => expect(log.dispatches).toHaveLength(1));
    expect(log.dispatches[0]?.effort).toBe('max');
  });

  test('d dispatches a ready task from anywhere on the page', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1')] }), { layout: 'full' });
    press('d');
    await waitFor(() => expect(log.dispatches).toHaveLength(1));
    expect(log.dispatches[0]?.stayInPlace).toBe(false);
  });

  test('every test-only fake executor stays out of the picker', () => {
    const executor = (name: string) => ({
      name,
      reportsCost: true,
      reportsTurns: true,
      enforcesCaps: true,
    });
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1')],
        project: {
          executors: {
            executors: [
              executor('claude'),
              executor('fake'),
              executor('fake-ask'),
            ],
            default: 'claude',
          },
        },
      }),
      { layout: 'full' }
    );
    // Read as text: a failed match on a DOM node never finishes printing it.
    expect(
      screen.queryByRole('button', { name: 'Executor' })?.textContent
    ).toBeUndefined();
  });
});

describe('the docs a task links', () => {
  // A client whose task links one spec doc, recording each docs-linking target.
  function linkingASpec(asked: string[]) {
    return {
      docsLinking: (target: string) => {
        asked.push(target);
        return Promise.resolve({
          docs: [
            {
              doc: { id: 'doc-1', title: 'Burgess spec', status: 'draft' },
              rel: 'spec',
              source: 'manual',
              fromParent: false,
            },
          ],
        });
      },
    } as unknown as Partial<ApiClient>;
  }

  test('the spec lists them after its attachments and opens one', async () => {
    const opened: [string, string | null][] = [];
    const host = fakeHost(newLog(), {
      tasks: [task('t-1')],
      body: BODY,
      client: linkingASpec([]),
    });
    mount({ ...host, openDoc: (id, anchor) => opened.push([id, anchor]) });
    fireEvent.click(
      await screen.findByRole('button', { name: /Burgess spec/ })
    );
    expect(opened).toEqual([['doc-1', null]]);
    const docs = screen.getByRole('heading', { name: 'Docs' });
    const attachments = document.querySelector('[data-slot=attachments-row]');
    expect(
      attachments !== null &&
        (attachments.compareDocumentPosition(docs) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0
    ).toBe(true);
  });

  test('no Docs block, and no docs request, for a caller who cannot read docs', async () => {
    const asked: string[] = [];
    mount(
      fakeHost(newLog(), {
        tasks: [task('t-1')],
        body: BODY,
        client: linkingASpec(asked),
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Docs' })).toBeNull();
  });
});

// A thread view whose render throws, as a broken ThreadsView would.
function Boom(): ReactNode {
  throw new Error('thread boom');
}

describe('the task thread', () => {
  // A host whose thread view names the task it was drawn for.
  function hostWithThreads(): TaskPageHost {
    return {
      ...fakeHost(newLog(), { tasks: [task('t-1')] }),
      threadView: (taskId) => <p>threads of {taskId}</p>,
    };
  }

  test('the Thread toggle shows the task’s threads, and again returns to its state', () => {
    mount(hostWithThreads());
    const toggle = screen.getByRole('button', { name: 'Thread' });
    fireEvent.click(toggle);
    expect(modeOf()).toBe('thread');
    expect(screen.getByText('threads of t-1')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Thread' }));
    expect(modeOf()).toBe('spec');
  });

  test('the full page keeps the thread mode in the caller', () => {
    const changes: TaskTab[] = [];
    mount(hostWithThreads(), {
      layout: 'full',
      mode: 'auto',
      onModeChange: (tab) => changes.push(tab),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Thread' }));
    expect(changes).toEqual(['thread']);
  });

  test('a crashing thread view is contained to its tab', () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      mount({
        ...fakeHost(newLog(), { tasks: [task('t-1')] }),
        threadView: () => <Boom />,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Thread' }));
      expect(
        screen.getByText('Something went wrong rendering this tab')
      ).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Thread' }));
      expect(modeOf()).toBe('spec');
      expect(screen.queryByText(/Something went wrong/)).toBeNull();
    } finally {
      console.error = quiet;
    }
  });

  test('no Thread toggle, and a thread mode falls back to the state, without a thread view', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), {
      layout: 'full',
      mode: 'thread',
    });
    expect(screen.queryByRole('button', { name: 'Thread' })).toBeNull();
    expect(modeOf()).toBe('spec');
  });
});

describe('the rail', () => {
  test('property edits go through the project’s update', async () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [task('t-1')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Change estimate' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '3 points' }));
    expect(log.updates).toEqual([{ id: 't-1', patch: { estimate: 3 } }]);
  });

  test('a new comment shows at once, and only its author gets a comment’s menu', async () => {
    const log = newLog();
    mount(
      fakeHost(log, {
        tasks: [task('t-1')],
        comments: [
          comment('c-1', 'human:wyat', 'mine'),
          comment('c-2', 'human:maya', 'theirs'),
          comment('c-3', 'human:maya', 'a reply', 'c-1'),
        ],
      })
    );
    await waitFor(() => expect(screen.getByText('theirs')).not.toBeNull());
    expect(
      screen.getAllByRole('button', { name: 'Comment actions' })
    ).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Leave a comment'), {
      target: { value: 'ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }));
    await waitFor(() => expect(screen.getByText('ship it')).not.toBeNull());
    expect(screen.getByText('Sending…')).not.toBeNull();
    expect(log.comments).toEqual(['ship it']);
  });

  test('s opens the status picker', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }), { layout: 'full' });
    press('s');
    expect(await screen.findByRole('menu')).not.toBeNull();
  });
});

describe('the narrow pane', () => {
  test('its label chips are colored label pills, like the rail’s', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1', { labels: ['bug'] })] }), {
      layout: 'split',
    });
    const chips = await waitFor(() => {
      const found = document.querySelector('[data-slot=property-chips]');
      if (!(found instanceof HTMLElement)) throw new Error('no chips yet');
      return found;
    });
    // A label pill leads with a dot in colorForLabel's color; happy-dom drops
    // that nested var() from the style, so the dot itself is what's checked.
    const pill = within(chips)
      .getByText('bug')
      .closest('[data-slot=label-pill]');
    expect(pill?.querySelector('span[aria-hidden]') ?? null).not.toBeNull();
  });
});

describe('keyboard', () => {
  const opened = () => document.querySelector('[data-popup-open]') !== null;

  test('a property key opens its picker in the rail', async () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    const main = document.querySelector('[data-slot=task-main]');
    if (main === null) throw new Error('no main pane');
    fireEvent.keyDown(main, { key: 's' });
    await waitFor(() => expect(opened()).toBe(true));
  });

  test('a key already handled, or meant for a page nested inside, is left alone', () => {
    mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
    const main = document.querySelector('[data-slot=task-main]');
    if (main === null) throw new Error('no main pane');
    // The Flight Plan's canvas takes h/j/k/l and `d` itself.
    const canvas = document.createElement('div');
    canvas.addEventListener('keydown', (e) => e.preventDefault());
    main.append(canvas);
    fireEvent.keyDown(canvas, { key: 'l' });
    // The Flight Plan's pane holds a task page of its own.
    const nested = document.createElement('div');
    nested.dataset.slot = 'task-page';
    const inner = document.createElement('button');
    nested.append(inner);
    main.append(nested);
    fireEvent.keyDown(inner, { key: 's' });
    expect(opened()).toBe(false);
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
        client: { getTaskPresence } as Partial<ApiClient>,
      })
    );
    expect(
      await screen.findByText("Running on bob's desk, waiting on ada")
    ).toBeTruthy();
  });
});
