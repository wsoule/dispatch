import type { ApiClient, RunMeta } from '@dispatch/client';
import type {
  TaskAttachment,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { SavedViewsApi } from '../../../hooks/useSavedViews';
import type { FavoriteRef } from '../../../lib/savedViews';
import { DeepLinkProvider } from '../../shell/DeepLinkContext';
import { SavedViewsProvider } from '../../shell/SavedViewsContext';
import {
  type ShellActions,
  ShellActionsProvider,
} from '../../shell/ShellActionsContext';
import { ToastProvider } from '../../shell/Toasts';
import type { TaskDetailPanelProps } from './TaskPage';
import { TaskPage } from './TaskPage';

const STATUSES = ['draft', 'ready', 'working', 'review', 'landing', 'landed'];

function task(
  id: string,
  title: string,
  overrides: Partial<TaskDoc['meta']> = {},
  body = ''
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'working',
      kind: 'task',
      priority: 'none',
      parent: null,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      created: '2026-08-10T12:00:00.000Z',
      updated: '2026-09-13T12:00:00.000Z',
      external: null,
      selfReview: true,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...overrides,
    },
    body,
  };
}

const BODY = `
## Description

Apply the **Burgess** rule everywhere.

## Acceptance Criteria

- tests pass
- docs updated

## Activity

- 2026-09-13T10:00:00.000Z dispatched (claude, branch dispatch/t-8f2a)
- 2026-09-13T11:00:00.000Z Looks fine so far. — agent:wyat/claude
`;

/** Every call the page made through the caller's write handlers, in order. */
interface Log {
  updates: { id: string; patch: UpdatePatch }[];
  moves: { id: string; status: string }[];
  dispatches: string[];
  copied: string[];
  presets: unknown[];
  /** Task ids handed to `DeepLinkProvider`'s `copyTaskLink`. */
  links: string[];
  /** Refs handed to `SavedViewsProvider`'s `toggleFavorite`. */
  favorites: FavoriteRef[];
}

// A full `TaskDetailPanelProps` literal, so every key the interface declares is exercised
// here; the contract with `App.tsx`'s `buildTaskPanelProps` is checked by App.tsx's own
// typecheck against that interface.
function panelProps(
  doc: TaskDoc,
  log: Log,
  extra: Partial<TaskDetailPanelProps> = {}
): TaskDetailPanelProps {
  return {
    doc,
    defaultModel: 'claude-sonnet-4-5',
    statuses: STATUSES,
    ready: true,
    run: undefined,
    runs: [],
    epics: [],
    tasks: [doc],
    latestRunByTaskId: new Map<string, RunMeta>(),
    onUpdate: (id, patch) => {
      log.updates.push({ id, patch });
      return Promise.resolve();
    },
    onMoveStatus: (id, status) => {
      log.moves.push({ id, status });
      return Promise.resolve();
    },
    onDispatch: (id) => {
      log.dispatches.push(id);
      return Promise.resolve();
    },
    onEnrich: () => Promise.resolve(),
    enrichPlan: undefined,
    onDismissEnrich: () => {},
    onAnswerEnrich: undefined,
    onOpenSession: () => {},
    onOpenTask: () => {},
    linearLinks: {},
    linearConfigured: false,
    onPushToLinear: () =>
      Promise.resolve({
        at: '2026-09-20T10:00:00.000Z',
        pulled: 0,
        pushed: 0,
        created: 0,
        createdIssues: 0,
        conflicts: 0,
        errors: [],
        rateLimited: false,
      }),
    client: null,
    port: undefined,
    fixLoopEscalation: [],
    ...extra,
  };
}

function shellWith(log: Log): ShellActions {
  const noop = () => {};
  return {
    openTask: noop,
    peekTask: noop,
    openCreateTask: (preset) => log.presets.push(preset),
    createPreset: null,
    closeCreateTask: noop,
    openPalette: noop,
    toggleSidebar: noop,
    sidebarHidden: false,
    openOverseer: noop,
    setProjectView: noop,
    setGlobalView: noop,
    openShortcuts: noop,
    copyTaskId: (id) => log.copied.push(id),
  };
}

// Only the two members the page reads; the rest throw so a test that reaches
// them fails loudly rather than passing on a stub.
function savedViewsWith(log: Log, favorite: boolean): SavedViewsApi {
  const unused = () => {
    throw new Error('not exercised by TaskPage');
  };
  return {
    views: [],
    favorites: [],
    activeViewId: null,
    activeView: null,
    selectView: unused,
    clearActiveView: unused,
    saveView: unused,
    updateView: unused,
    renameView: unused,
    deleteView: unused,
    toggleFavorite: (ref) => log.favorites.push(ref),
    isFavorite: () => favorite,
  };
}

function Providers({
  log,
  children,
  deepLinks = true,
  savedViews = true,
  favorite = false,
}: {
  log: Log;
  children: ReactNode;
  /** False leaves the page outside `DeepLinkProvider`, the pre-P7 and harness state. */
  deepLinks?: boolean;
  savedViews?: boolean;
  favorite?: boolean;
}) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ShellActionsProvider value={shellWith(log)}>
          <DeepLinkProvider
            value={
              deepLinks ? { copyTaskLink: (id) => log.links.push(id) } : null
            }
          >
            <SavedViewsProvider
              value={savedViews ? savedViewsWith(log, favorite) : null}
            >
              {children}
            </SavedViewsProvider>
          </DeepLinkProvider>
        </ShellActionsProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

// A client that records attachment uploads and leaves every other fetch the
// page makes (findings, verification, ledger, impact) pending, so those
// sections render their loading state and nothing resolves against a stub.
function clientRecordingUploads(
  uploads: { id: string; names: string[] }[]
): ApiClient {
  const pending = () => new Promise<never>(() => {});
  return new Proxy({} as ApiClient, {
    get(_target, key) {
      if (key === 'uploadTaskAttachments') {
        return (id: string, files: File[]) => {
          uploads.push({ id, names: files.map((f) => f.name) });
          return Promise.resolve({} as never);
        };
      }
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return pending;
    },
  });
}

function newLog(): Log {
  return {
    updates: [],
    moves: [],
    dispatches: [],
    copied: [],
    presets: [],
    links: [],
    favorites: [],
  };
}

function mountPage(
  doc = task('t-8f2a', 'Apply to the Burgess', {}, BODY),
  extra: Partial<TaskDetailPanelProps> = {},
  log = newLog()
) {
  render(
    <Providers log={log}>
      <TaskPage
        mode="page"
        projectName="Dispatch"
        {...panelProps(doc, log, extra)}
      />
    </Providers>
  );
  return log;
}

// A menu positions itself a microtask after mount (floating-ui), so anything that opens
// one is done inside an async `act` that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

describe('TaskPage', () => {
  test('the executor picker appears only when the daemon offers a choice, and hides the Claude model pill for another executor', async () => {
    const dispatched: { executor?: string; model?: string }[] = [];
    const executors = {
      executors: [
        {
          name: 'claude',
          reportsCost: true,
          reportsTurns: true,
          enforcesCaps: true,
        },
        {
          name: 'codex',
          reportsCost: false,
          reportsTurns: true,
          enforcesCaps: false,
        },
        {
          name: 'fake',
          reportsCost: true,
          reportsTurns: true,
          enforcesCaps: true,
        },
      ],
      default: 'claude',
    };
    mountPage(undefined, {
      executors,
      onDispatch: (_id, executor, model) => {
        dispatched.push({ executor, model });
        return Promise.resolve();
      },
    });
    expect(screen.getByRole('button', { name: 'Executor' }).textContent).toBe(
      'claude'
    );
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy();

    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Executor' }))
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'codex' }))
    );
    expect(screen.getByRole('button', { name: 'Executor' }).textContent).toBe(
      'codex'
    );
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull();

    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    );
    expect(dispatched).toEqual([{ executor: 'codex', model: undefined }]);
  });

  test('a single real executor shows no picker and dispatches with the Claude model', async () => {
    const dispatched: { executor?: string; model?: string }[] = [];
    mountPage(undefined, {
      executors: {
        executors: [
          {
            name: 'claude',
            reportsCost: true,
            reportsTurns: true,
            enforcesCaps: true,
          },
        ],
        default: 'claude',
      },
      onDispatch: (_id, executor, model) => {
        dispatched.push({ executor, model });
        return Promise.resolve();
      },
    });
    expect(screen.queryByRole('button', { name: 'Executor' })).toBeNull();
    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    );
    expect(dispatched).toEqual([
      { executor: undefined, model: 'claude-sonnet-4-5' },
    ]);
  });

  test('the effort picker defaults to sending none and sends the level picked', async () => {
    const efforts: (string | undefined)[] = [];
    mountPage(undefined, {
      defaultEffort: 'xhigh',
      onDispatch: (_id, _executor, _model, opts) => {
        efforts.push(opts?.effort);
        return Promise.resolve();
      },
    });
    const picker = screen.getByRole('button', { name: 'Effort' });
    expect(picker.textContent).toBe('Default (Extra high)');

    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    );
    await settle(() => fireEvent.click(picker));
    await settle(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    );
    expect(efforts).toEqual([undefined, 'max']);
  });

  test('the header crumb reads Project › Tasks › id Title with the three icons', () => {
    mountPage();
    const crumb = document.querySelector('[data-slot="page-header-crumb"]');
    expect(crumb?.textContent).toBe(
      'Dispatch›Tasks›t-8f2aApply to the Burgess'
    );
    const id = crumb?.querySelector('[data-slot="task-crumb"] > span');
    expect(id?.className).toContain('font-book');
    expect(id?.className).toContain('text-muted-foreground');
    expect(screen.getByRole('button', { name: 'Copy task id' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Toggle side panel' })
    ).toBeTruthy();
    // No second header row without tabs.
    expect(
      document.querySelectorAll('[data-slot="page-header-row"]')
    ).toHaveLength(1);
  });

  test('copy id goes through the shell seam', () => {
    const log = mountPage();
    fireEvent.click(screen.getByRole('button', { name: 'Copy task id' }));
    expect(log.copied).toEqual(['t-8f2a']);
  });

  test('Copy link follows Copy task id and goes through the deep-link provider', () => {
    const log = mountPage();
    const buttons = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(buttons.indexOf('Copy link')).toBe(
      buttons.indexOf('Copy task id') + 1
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(log.links).toEqual(['t-8f2a']);
  });

  test('no Copy link and no star outside their providers', () => {
    const log = newLog();
    render(
      <Providers log={log} deepLinks={false} savedViews={false}>
        <TaskPage
          mode="page"
          projectName="Dispatch"
          {...panelProps(task('t-8f2a', 'Apply', {}, BODY), log)}
        />
      </Providers>
    );
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Favorite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unfavorite' })).toBeNull();
  });

  test('the star after the crumb toggles the task favorite and carries data-active', () => {
    const log = newLog();
    render(
      <Providers log={log} favorite>
        <TaskPage
          mode="page"
          projectName="Dispatch"
          {...panelProps(task('t-8f2a', 'Apply', {}, BODY), log)}
        />
      </Providers>
    );
    const star = screen.getByRole('button', { name: 'Unfavorite' });
    expect(star.getAttribute('data-active')).toBe('true');
    expect(
      document
        .querySelector('[data-slot="page-header-crumb"]')
        ?.compareDocumentPosition(star)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.click(star);
    expect(log.favorites).toEqual([{ kind: 'task', id: 't-8f2a' }]);
  });

  test("the attachments row under the description lists the doc's files", () => {
    const attachments: TaskAttachment[] = [
      {
        name: 'spec.png',
        path: '.dispatch/attachments/t-8f2a/spec.png',
        size: 48 * 1024,
        addedAt: '2026-09-20T10:00:00Z',
      },
    ];
    mountPage(task('t-8f2a', 'Apply', { attachments }, BODY));
    const row = document.querySelector('[data-slot="attachments-row"]');
    expect(row?.textContent).toContain('spec.png · 48 KB');
    // Right after the description (its Acceptance criteria section closes it).
    const acceptance = Array.from(
      document.querySelectorAll('[data-slot="main-section"]')
    ).find((s) => s.textContent?.includes('Acceptance criteria'));
    expect(acceptance?.nextElementSibling).toBe(row);
  });

  // The content column is the drop target, so a drop that bubbles up from any
  // field on the page goes through the same upload as the row's picker.
  test('dropping a file on the page uploads it through the client', async () => {
    const uploads: { id: string; names: string[] }[] = [];
    mountPage(task('t-8f2a', 'Apply', {}, BODY), {
      client: clientRecordingUploads(uploads),
      port: 4100,
    });
    const png = new File(['png-bytes'], 'spec.png', { type: 'image/png' });
    await settle(() => {
      fireEvent.drop(screen.getByLabelText('Task title'), {
        dataTransfer: { files: [png], items: [] },
      });
    });
    expect(uploads).toEqual([{ id: 't-8f2a', names: ['spec.png'] }]);
  });

  // A text paste carries no files and must reach whichever field has focus
  // untouched.
  test('a text-only paste is left to the field and never reaches the client', () => {
    const uploads: { id: string; names: string[] }[] = [];
    mountPage(task('t-8f2a', 'Apply', {}, BODY), {
      client: clientRecordingUploads(uploads),
      port: 4100,
    });
    const title = screen.getByLabelText('Task title');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], items: [], getData: () => 'plain text' },
    });
    title.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(uploads).toEqual([]);
  });

  test('the title is a 24px in-place textarea and the description is rendered prose', () => {
    mountPage();
    const title = screen.getByLabelText<HTMLTextAreaElement>('Task title');
    expect(title.value).toBe('Apply to the Burgess');
    expect(title.className).toContain('text-[24px]');
    const prose = document.querySelector(
      '[data-slot="markdown"][data-variant="prose"]'
    );
    expect(prose?.querySelector('strong')?.textContent).toBe('Burgess');
    // Acceptance criteria render as a checklist.
    expect(
      document.querySelectorAll('input[type="checkbox"]').length
    ).toBeGreaterThanOrEqual(2);
    // No uppercase-tracked labels or mono ids in the header or the rail.
    for (const slot of ['page-header', 'properties-rail', 'task-actions']) {
      const el = document.querySelector(`[data-slot="${slot}"]`);
      expect(el?.innerHTML).not.toContain('uppercase');
      expect(el?.innerHTML).not.toContain('font-mono');
    }
  });

  test('clicking the description swaps in a borderless editor that saves on blur', () => {
    const log = mountPage();
    const prose = document.querySelector(
      '[data-slot="editable-body"][data-field="Description"]'
    );
    if (prose === null) throw new Error('description not rendered');
    // Rendered prose is not a <button>: it is selectable and reads as itself.
    expect(prose.tagName).toBe('DIV');
    expect(prose.getAttribute('aria-label')).toBeNull();
    fireEvent.click(prose);
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Description');
    expect(editor.dataset['variant']).toBe('borderless');
    fireEvent.change(editor, { target: { value: 'New body' } });
    fireEvent.blur(editor);
    expect(log.updates).toEqual([
      { id: 't-8f2a', patch: { description: 'New body' } },
    ]);
  });

  test('the rail is 280px with Properties rows whose unset copy reads as an action', () => {
    mountPage();
    const rail = document.querySelector('[data-slot="properties-rail"]');
    expect(rail?.className).toContain('w-[280px]');
    expect(rail?.className).not.toContain('border-l');
    const heading = rail?.querySelector('[data-slot="rail-section"] > div');
    expect(heading?.textContent).toBe('Properties');
    expect(heading?.className).toContain('text-[13px]');
    expect(
      screen.getByRole('button', { name: 'Change status' }).textContent
    ).toBe('Working');
    expect(
      screen.getByRole('button', { name: 'Change priority' }).textContent
    ).toBe('Set priority');
    expect(
      screen.getByRole('button', { name: 'Change assignee' }).textContent
    ).toBe('Assign');
    expect(
      screen.getByRole('button', { name: 'Change milestone' }).textContent
    ).toBe('Add to milestone');
    expect(
      screen.getByRole('button', { name: 'Change epic' }).textContent
    ).toBe('Add to epic');
    expect(screen.getByRole('button', { name: 'Add label' })).toBeTruthy();
    expect(screen.queryByText('No labels')).toBeNull();
    expect(screen.queryByText('No blockers')).toBeNull();
    // Every property row is a 32px ghost row.
    for (const name of ['Change status', 'Change milestone', 'Add label']) {
      expect(screen.getByRole('button', { name }).className).toContain('h-8');
    }
  });

  test('the side-panel toggle hides the rail', () => {
    mountPage();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle side panel' }));
    expect(document.querySelector('[data-slot="properties-rail"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle side panel' }));
    expect(
      document.querySelector('[data-slot="properties-rail"]')
    ).not.toBeNull();
  });

  test('the activity feed classifies events and comments and ends in a composer', () => {
    mountPage();
    expect(
      document.querySelectorAll('[data-slot="activity-event"]')
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-slot="activity-comment"]')
    ).toHaveLength(1);
    expect(
      document.querySelector('[data-slot="comment-composer"]')
    ).not.toBeNull();
  });

  test('⌘⏎ in the composer appends a timestamped, human-credited note', () => {
    const log = mountPage();
    const field = screen.getByLabelText('Leave a comment');
    fireEvent.change(field, { target: { value: 'ship it' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(log.updates).toHaveLength(1);
    const patch = log.updates[0]?.patch;
    expect(patch?.activityActor).toBe('human');
    expect(patch?.appendActivity).toMatch(/^\d{4}-\d{2}-\d{2}T.* ship it$/);
  });

  test('pressing s on the page opens the status picker in the rail', async () => {
    mountPage();
    await settle(() => {
      fireEvent.keyDown(document.body, { key: 's' });
    });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toContain(
      'Landed'
    );
  });

  test('an epic shows its children as sub-task rows with a progress count and a + preset', () => {
    const epic = task('e-1', 'Ship the pass', { kind: 'epic' });
    const done = task('t-2', 'Tokens', { parent: 'e-1', status: 'landed' });
    const open = task('t-3', 'Shell', { parent: 'e-1' });
    const log = mountPage(epic, { tasks: [epic, done, open] });
    const block = document.querySelector('[data-slot="subtasks-block"]');
    expect(block?.textContent).toContain('Sub-tasks');
    expect(block?.textContent).toContain('1/2');
    expect(block?.querySelectorAll('[data-slot="list-row"]')).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add sub-task to Ship the pass' })
    );
    expect(log.presets).toEqual([{ epic: 'e-1' }]);
  });

  test('a peek draws a 40px chrome row with expand and close instead of the page header', () => {
    const log = newLog();
    const closed: string[] = [];
    render(
      <Providers log={log}>
        <TaskPage
          mode="peek"
          projectName="Dispatch"
          onExpand={() => closed.push('expand')}
          onClose={() => closed.push('close')}
          {...panelProps(task('t-8f2a', 'Apply', {}, BODY), log)}
        />
      </Providers>
    );
    expect(document.querySelector('[data-slot="page-header"]')).toBeNull();
    const chrome = document.querySelector('[data-slot="task-peek-chrome"]');
    expect(chrome?.className).toContain('h-10');
    expect(chrome?.textContent).toContain('t-8f2a');
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand to full view' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toEqual(['expand', 'close']);
  });
});
