import type { CreateInput, TaskListItem } from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { DraftView } from './DraftView';

function draftRecord(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'd-1',
    prompt: 'cache the search index',
    plannerName: 'planner',
    state: 'ready',
    message: '',
    proposal: {
      tasks: [
        {
          title: 'Cache the search index in redis',
          description: 'Keep the index warm between requests.',
          acceptanceCriteria: ['Index survives a restart', 'p95 under 50ms'],
          priority: 'high',
        },
      ],
    } as unknown as DraftRecord['proposal'],
    questions: [],
    error: null,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  };
}

// A container the draft may be filed under (only the fields the rail reads).
function epic(id: string, title: string, kind: string): TaskListItem {
  return {
    meta: { id, title, kind, icon: null, color: null },
  } as unknown as TaskListItem;
}

function mount({
  draft = draftRecord(),
  projectName,
  onCreate = () => Promise.resolve(),
  onRetry,
  send,
  epics = [],
  dismiss = () => Promise.resolve(),
}: {
  draft?: DraftRecord;
  projectName?: string;
  onCreate?: (input: CreateInput) => Promise<void>;
  onRetry?: () => Promise<void>;
  send?: ComponentProps<typeof DraftView>['send'];
  epics?: TaskListItem[];
  dismiss?: () => Promise<void>;
} = {}) {
  const dismissed: string[] = [];
  const messages: string[] = [];
  let done = 0;
  const data = {
    config: { statuses: ['draft', 'ready', 'working', 'landed'] },
    epics,
    handleDismissDraft: (id: string) => {
      dismissed.push(id);
      return dismiss();
    },
    handleSendDraftMessage: (_id: string, text: string) => {
      messages.push(text);
      return Promise.resolve();
    },
  } as unknown as DispatchProjectData;
  const created: CreateInput[] = [];
  render(
    <DraftView
      data={data}
      projectName={projectName}
      draft={draft}
      onCreate={(input) => {
        created.push(input);
        return onCreate(input);
      }}
      onRetry={onRetry}
      send={send}
      onDone={() => {
        done += 1;
      }}
    />
  );
  return { created, dismissed, messages, done: () => done };
}

// The rail's picker for one property, by its trigger's name ("Status: Draft").
function railTrigger(name: string): HTMLElement {
  const rail = screen.getByRole('complementary', { name: 'Properties' });
  return within(rail).getByRole('button', { name });
}

// Selects characters [start, end) of the prompt's text.
function selectInPrompt(start: number, end: number) {
  const prompt = screen.getByText('cache the search index');
  const text = prompt.firstChild;
  if (text === null) throw new Error('the prompt has no text');
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  act(() => {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

// A pointer drag over characters [start, end) of the prompt: down in the prompt, the
// selection, then the pointerup that settles it.
function dragInPrompt(start: number, end: number) {
  fireEvent.pointerDown(screen.getByText('cache the search index'));
  selectInPrompt(start, end);
  act(() => {
    fireEvent.pointerUp(document);
  });
}

test('the task title is the page heading over prose, under a Drafts crumb', () => {
  mount({ projectName: 'dispatch' });

  const title = screen.getByLabelText<HTMLInputElement>('Task title');
  expect(title.value).toBe('Cache the search index in redis');
  expect(screen.queryByRole('heading', { name: 'Review draft' })).toBeNull();
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('Task description').value
  ).toBe('Keep the index warm between requests.');

  const crumb = document.querySelector('[data-slot=page-header-crumb]');
  expect(crumb?.textContent).toContain('dispatch');
  expect(crumb?.textContent).toContain('Drafts');
  expect(crumb?.querySelector('[aria-current="page"]')?.textContent).toBe(
    'Draft'
  );
  expect(
    screen.getByText('Nothing is written until you create the task.')
  ).toBeTruthy();
});

test('acceptance criteria render as a checklist and the properties rail holds pickers', () => {
  mount();

  expect(
    screen.getByLabelText<HTMLInputElement>('Acceptance criterion 1').value
  ).toBe('Index survives a restart');
  expect(
    screen.getByLabelText<HTMLInputElement>('Acceptance criterion 2').value
  ).toBe('p95 under 50ms');
  expect(document.querySelectorAll('[data-slot=criterion-box]')).toHaveLength(
    2
  );
  expect(
    screen.getByRole('region', { name: 'Acceptance criteria' })
  ).toBeTruthy();

  expect(railTrigger('Status: Draft')).toBeTruthy();
  expect(railTrigger('Priority: High')).toBeTruthy();
  expect(railTrigger('Parent: No parent')).toBeTruthy();
});

test('criteria can be removed and added', () => {
  mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove acceptance criterion 1' })
  );
  expect(
    screen.getByLabelText<HTMLInputElement>('Acceptance criterion 1').value
  ).toBe('p95 under 50ms');
  expect(screen.queryByLabelText('Acceptance criterion 2')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
  expect(
    screen.getByLabelText<HTMLInputElement>('Acceptance criterion 2').value
  ).toBe('');
});

test('the rail pickers edit the draft that Create task saves', async () => {
  const { created } = mount({
    epics: [
      epic('m-1', 'Search speed', 'milestone'),
      {
        ...epic('m-2', 'Old milestone', 'milestone'),
        meta: {
          ...epic('m-2', 'Old milestone', 'milestone').meta,
          archivedAt: '2026-09-01T00:00:00.000Z',
        },
      } as TaskListItem,
    ],
  });

  fireEvent.click(railTrigger('Status: Draft'));
  fireEvent.click(screen.getByRole('option', { name: /Ready/ }));
  expect(railTrigger('Status: Ready')).toBeTruthy();

  fireEvent.click(railTrigger('Priority: High'));
  fireEvent.click(screen.getByRole('option', { name: /Urgent/ }));
  expect(railTrigger('Priority: Urgent')).toBeTruthy();

  fireEvent.click(railTrigger('Parent: No parent'));
  // An archived container is not offered.
  expect(screen.queryByRole('option', { name: /Old milestone/ })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: /Search speed/ }));
  expect(railTrigger('Parent: Search speed')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});
  expect(created[0]).toMatchObject({
    status: 'ready',
    priority: 'urgent',
    parent: 'm-1',
  });
});

test('Create task saves the edited draft, dismisses it and leaves', async () => {
  const { created, dismissed, done } = mount();

  fireEvent.change(screen.getByLabelText('Task title'), {
    target: { value: 'Cache the index' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});

  expect(created[0]).toMatchObject({
    title: 'Cache the index',
    status: 'draft',
    priority: 'high',
  });
  expect(dismissed).toEqual(['d-1']);
  expect(done()).toBe(1);
});

test('a draft started inside a container saves the task under it', async () => {
  const { created } = mount({ draft: draftRecord({ parent: 'e-7' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});
  expect(created[0]).toMatchObject({ parent: 'e-7' });
});

test('a failed create keeps the draft with the error inline', async () => {
  const { dismissed, done } = mount({
    onCreate: () => Promise.reject(new Error('daemon said no')),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});

  expect(screen.getByRole('alert').textContent).toBe('daemon said no');
  expect(dismissed).toEqual([]);
  expect(done()).toBe(0);
});

test('Discard dismisses without creating', async () => {
  const { created, dismissed, done } = mount();

  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await act(async () => {});

  expect(created).toEqual([]);
  expect(dismissed).toEqual(['d-1']);
  expect(done()).toBe(1);
});

test('Discard reads Discarding… while the draft is dismissed', async () => {
  let release = () => {};
  const { done } = mount({
    dismiss: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  const busy = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Discarding…',
  });
  expect(busy.disabled).toBe(true);
  expect(busy.getAttribute('aria-busy')).toBe('true');
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(done()).toBe(1);
});

// Picks a prompt menu action and lets its (synchronous) save settle.
async function pickAction(option: HTMLElement) {
  await act(async () => {
    fireEvent.click(option);
    await Promise.resolve();
  });
}

test('dragging over prompt text opens the prompt menu; Explain asks the planner about it', async () => {
  const { messages } = mount();
  dragInPrompt(10, 22);
  const menu = screen.getByRole('listbox', { name: 'Prompt actions' });
  expect(
    within(menu)
      .getAllByRole('option')
      .map((option) => option.textContent)
  ).toEqual(['Explain', 'Improve', 'Shorten', 'Tone', 'Grammar']);
  // Focus moving into the menu clears the selection; the menu stays.
  act(() => document.getSelection()?.removeAllRanges());
  await pickAction(within(menu).getByRole('option', { name: 'Explain' }));
  expect(messages).toEqual(['Explain this: "search index"']);
  expect(screen.queryByRole('listbox', { name: 'Prompt actions' })).toBeNull();
});

test('a pointer drag opens the menu on pointerup, not mid-drag', () => {
  mount();
  fireEvent.pointerDown(screen.getByText('cache the search index'));
  selectInPrompt(0, 5);
  expect(screen.queryByRole('listbox', { name: 'Prompt actions' })).toBeNull();
  act(() => {
    fireEvent.pointerUp(document);
  });
  expect(screen.getByRole('listbox', { name: 'Prompt actions' })).toBeTruthy();
});

test('Escape closes the menu, and the same selection does not reopen it', () => {
  mount();
  dragInPrompt(0, 5);
  const menu = screen.getByRole('listbox', { name: 'Prompt actions' });
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(screen.queryByRole('listbox', { name: 'Prompt actions' })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Prompt actions' })
  );
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
  // A press and release that leaves the same selection does not reopen it either.
  fireEvent.pointerDown(screen.getByText('cache the search index'));
  act(() => {
    fireEvent.pointerUp(document);
  });
  expect(screen.queryByRole('listbox', { name: 'Prompt actions' })).toBeNull();
});

test('a keyboard selection leaves focus where it is; the trigger acts on it', async () => {
  const { messages } = mount();
  const trigger = screen.getByRole('button', { name: 'Prompt actions' });
  act(() => trigger.focus());
  // Two steps of a Shift+Arrow selection: no menu takes focus between them.
  selectInPrompt(10, 15);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
  selectInPrompt(10, 22);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(screen.queryByRole('listbox', { name: 'Prompt actions' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  await pickAction(screen.getByRole('option', { name: 'Explain' }));
  expect(messages).toEqual(['Explain this: "search index"']);
});

test('Tone steps into its voices, which are not wired up yet', async () => {
  const { messages } = mount();
  dragInPrompt(0, 5);
  fireEvent.click(screen.getByRole('option', { name: 'Tone' }));
  const tone = screen.getByRole('listbox', { name: 'Tone' });
  await pickAction(within(tone).getByRole('option', { name: 'Professional' }));
  expect(
    screen
      .getByText("Professional isn't wired up yet — coming soon.")
      .getAttribute('role')
  ).toBe('status');
  expect(messages).toEqual([]);
});

test('the prompt menu trigger acts on the whole prompt', async () => {
  const { messages } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Prompt actions' }));
  await pickAction(screen.getByRole('option', { name: 'Improve' }));
  expect(messages).toEqual(['Improve this: "cache the search index"']);
});

test('without a proposal there is no rail and Create task is disabled', () => {
  mount({ draft: draftRecord({ proposal: null, state: 'running' }) });

  expect(
    screen.queryByRole('complementary', { name: 'Properties' })
  ).toBeNull();
  expect(screen.getByText('No proposed task yet.')).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Create task' })
      .disabled
  ).toBe(true);
});

test("a draft that failed says why instead of 'No proposed task yet'", () => {
  mount({
    draft: draftRecord({
      state: 'failed',
      proposal: null,
      plannerName: 'claude',
      error:
        'Claude Code CLI not found. Install it and re-dispatch — `curl -fsSL https://claude.ai/install.sh | bash`',
    }),
  });
  expect(
    screen.getByText("Claude Code isn't installed, or Dispatch can't find it.")
  ).toBeTruthy();
  expect(screen.queryByText('No proposed task yet.')).toBeNull();
  const empty = Array.from(document.querySelectorAll('p')).filter(
    (p) => p.textContent === ''
  );
  expect(empty).toHaveLength(0);
});

test('a failed draft offers Try again', async () => {
  let retried = 0;
  mount({
    draft: draftRecord({ state: 'failed', proposal: null, error: 'boom' }),
    onRetry: () => {
      retried += 1;
      return Promise.resolve();
    },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await Promise.resolve();
  });
  expect(retried).toBe(1);
});

test('the guided draft sends to the agent with the edited task', async () => {
  const sent: CreateInput[] = [];
  mount({
    send: {
      options: { modelChoice: false },
      onSend: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
    },
  });
  expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Task title'), {
    target: { value: 'Cache it' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    await Promise.resolve();
  });
  expect(sent[0]?.title).toBe('Cache it');
});

test('Just create the task waits behind More options', async () => {
  const { created, dismissed } = mount({
    send: { options: { modelChoice: false }, onSend: () => Promise.resolve() },
  });
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  const justCreate = await screen.findByRole('button', {
    name: 'Just create the task',
  });
  await act(async () => {
    fireEvent.click(justCreate);
    await Promise.resolve();
  });
  expect(created).toHaveLength(1);
  expect(dismissed).toEqual(['d-1']);
});

test('Discard and Just create the task are disabled while a send is pending', async () => {
  mount({
    send: {
      options: { modelChoice: false },
      onSend: () => new Promise<void>(() => {}),
    },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    await Promise.resolve();
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Discard' }).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  const justCreate = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Just create the task',
  });
  expect(justCreate.disabled).toBe(true);
});
