import type { CreateInput, TaskDoc } from '@dispatch/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../shell/ShellActionsContext';
import { ToastProvider } from '../shell/Toasts';
import {
  CREATE_TASK_DESCRIPTION_KEY,
  CREATE_TASK_TITLE_KEY,
  CreateTaskModal,
} from './CreateTaskModal';

const STATUSES = ['draft', 'ready', 'working', 'review', 'landed'];

// The title/description persist to localStorage; one test's typing must not leak into
// the next mount.
beforeEach(() => {
  window.localStorage.removeItem(CREATE_TASK_TITLE_KEY);
  window.localStorage.removeItem(CREATE_TASK_DESCRIPTION_KEY);
});

function epic(id: string, title: string): TaskDoc {
  return { meta: { id, title, kind: 'epic' }, body: '' } as unknown as TaskDoc;
}

// What a successful `handleCreate` resolves with: enough of a doc for the dialog to
// read the new id off.
function createdDoc(id: string): TaskDoc {
  return {
    meta: { id, title: 'created', kind: 'task' },
    body: '',
  } as unknown as TaskDoc;
}

// Only `createPreset` is read; every other verb throws if reached so a test that
// accidentally drives the shell says so.
function shellActions(createPreset: CreateTaskPreset | null): ShellActions {
  const unexpected = () => {
    throw new Error('unexpected shell action');
  };
  return {
    openTask: unexpected,
    openThread: unexpected,
    peekTask: unexpected,
    openCreateTask: unexpected,
    createPreset,
    closeCreateTask: unexpected,
    openPalette: unexpected,
    toggleSidebar: unexpected,
    sidebarHidden: false,
    openOverseer: unexpected,
    setProjectView: unexpected,
    setGlobalView: unexpected,
    openShortcuts: unexpected,
    copyTaskId: unexpected,
  };
}

function mount({
  preset = null,
  projectName,
  labels,
  onCreate = () => Promise.resolve(createdDoc('t-new001')),
  onUploadAttachments,
}: {
  preset?: CreateTaskPreset | null;
  projectName?: string;
  labels?: readonly string[];
  onCreate?: (input: CreateInput) => Promise<TaskDoc | null | undefined>;
  onUploadAttachments?: (taskId: string, files: File[]) => Promise<void>;
} = {}) {
  const created: CreateInput[] = [];
  let closed = 0;
  render(
    <ToastProvider>
      <ShellActionsProvider value={shellActions(preset)}>
        <CreateTaskModal
          statuses={STATUSES}
          epics={[epic('e-1', 'Search index')]}
          projectName={projectName}
          labels={labels}
          onCreate={(input) => {
            created.push(input);
            return onCreate(input);
          }}
          onUploadAttachments={onUploadAttachments}
          onClose={() => {
            closed += 1;
          }}
        />
      </ShellActionsProvider>
    </ToastProvider>
  );
  return { created, closed: () => closed };
}

function attachInput() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input mounted');
  return input;
}

function titleField() {
  return screen.getByLabelText<HTMLInputElement>('Task title');
}

function createButton() {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Create task' });
}

async function settle() {
  await act(async () => {});
}

test('renders the crumb header, borderless fields and property chips', () => {
  mount();
  expect(screen.getByText('New task')).toBeTruthy();
  expect(screen.getByLabelText('Close')).toBeTruthy();
  expect(screen.getByLabelText('Expand')).toBeTruthy();

  const title = titleField();
  expect(title.dataset['variant']).toBe('borderless');
  expect(title.className).toContain('text-[18px]');
  expect(title.placeholder).toBe('Task title');
  const description = screen.getByLabelText<HTMLTextAreaElement>('Description');
  expect(description.dataset['variant']).toBe('borderless');
  expect(description.placeholder).toBe('Add description…');

  // Chips read the status label and the property name while unset.
  expect(screen.getByLabelText('Status').textContent).toBe('Draft');
  const priority = screen.getByLabelText('Priority');
  expect(priority.textContent).toBe('Priority');
  expect(priority.className).toContain('h-7');
  expect(priority.dataset['unset']).toBe('true');
  expect(screen.getByLabelText('Assignee').textContent).toBe('Assignee');
  expect(screen.getByLabelText('Labels').textContent).toBe('Labels');

  // No labels, no boxed selects, no Cancel.
  expect(screen.queryByText('Title')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.getByText('Create more')).toBeTruthy();
});

test('reads status, epic and milestone from the shell createPreset', async () => {
  const { created } = mount({
    preset: { status: 'review', epic: 'e-1', milestone: 'September' },
  });
  expect(screen.getByLabelText('Status').textContent).toBe('Review');
  expect(screen.getByLabelText('Epic').textContent).toBe('Search index');
  expect(screen.getByLabelText('Milestone').textContent).toBe('September');

  fireEvent.change(titleField(), { target: { value: 'Ship it' } });
  fireEvent.click(createButton());
  await settle();

  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    title: 'Ship it',
    status: 'review',
    parent: 'e-1',
    milestone: 'September',
  });
});

test('Create task is disabled until a title exists and closes on success', async () => {
  const { created, closed } = mount();
  expect(createButton().disabled).toBe(true);

  fireEvent.change(titleField(), { target: { value: '  Cache the index  ' } });
  expect(createButton().disabled).toBe(false);
  fireEvent.click(createButton());
  await settle();

  expect(created[0]?.title).toBe('Cache the index');
  expect(created[0]?.status).toBe('draft');
  expect(closed()).toBe(1);
  expect(window.localStorage.getItem(CREATE_TASK_TITLE_KEY)).toBeNull();
});

test('⌘⏎ creates from any field', async () => {
  const { created, closed } = mount();
  fireEvent.change(titleField(), { target: { value: 'Keyboard' } });
  fireEvent.keyDown(titleField(), { key: 'Enter', metaKey: true });
  await settle();

  expect(created).toHaveLength(1);
  expect(closed()).toBe(1);
});

test('Create more keeps the dialog open and clears title and description', async () => {
  const { created, closed } = mount();
  // The words are the toggle's `<label>`, so clicking them flips it. (Clicking the switch
  // itself double-fires under happy-dom, which ignores the preventDefault Base UI uses
  // to stop the wrapping label's activation; browsers honour it.)
  const toggle = screen.getByRole('switch', { name: 'Create more' });
  fireEvent.click(screen.getByText('Create more'));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.change(titleField(), { target: { value: 'First' } });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'body' },
  });
  fireEvent.click(createButton());
  await settle();

  expect(created).toHaveLength(1);
  expect(closed()).toBe(0);
  expect(titleField().value).toBe('');
  expect(screen.getByLabelText<HTMLTextAreaElement>('Description').value).toBe(
    ''
  );
  // The chips survive for the next task.
  expect(screen.getByLabelText('Status').textContent).toBe('Draft');
});

test('Save as draft appears once a title exists and files the task as draft', async () => {
  const { created } = mount({ preset: { status: 'ready' } });
  expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull();

  fireEvent.change(titleField(), { target: { value: 'Later' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
  await settle();

  expect(created[0]?.status).toBe('draft');
});

test('a failed create keeps the dialog open with the title intact and says why', async () => {
  const { closed } = mount({
    onCreate: () => Promise.reject(new Error('daemon said no')),
  });
  fireEvent.change(titleField(), { target: { value: 'Keep me' } });
  fireEvent.click(createButton());
  await settle();

  expect(closed()).toBe(0);
  expect(titleField().value).toBe('Keep me');
  expect(createButton().disabled).toBe(false);
  // The error surfaces as a toast (`create::D57`) rather than vanishing.
  expect(await screen.findByText('Could not create task')).toBeTruthy();
  expect(await screen.findByText('daemon said no')).toBeTruthy();
});

test('the crumb reads the project name when one is given', () => {
  mount({ projectName: 'Audiobook' });
  expect(screen.getByText('Audiobook')).toBeTruthy();
  expect(screen.queryByText('Dispatch')).toBeNull();
});

test('the Labels chip opens the colour-dotted picker over the catalogue and reads back on create', async () => {
  const { created } = mount({ labels: ['bug', 'auth'] });
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Labels'));
    await Promise.resolve();
  });
  const options = screen.getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['auth', 'bug']);
  expect(document.querySelectorAll('[data-slot="label-dot"]').length).toBe(2);
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name: 'bug' }));
    await Promise.resolve();
  });
  // A multi-select: the picker stays open and the face reads the pick.
  expect(screen.getByLabelText('Labels').textContent).toBe('bug');
  expect(screen.queryAllByRole('option').length).toBeGreaterThan(0);

  fireEvent.change(titleField(), { target: { value: 'Tagged' } });
  fireEvent.click(createButton());
  await settle();
  expect(created[0]?.labels).toEqual(['bug']);
});

test('the footer paperclip is disabled without an upload handler', () => {
  mount();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Attach' }).disabled
  ).toBe(true);
  expect(document.querySelector('input[type="file"]')).toBeNull();
});

test('pending files show as removable pills and upload against the created id', async () => {
  const uploads: { taskId: string; names: string[] }[] = [];
  const { closed } = mount({
    onUploadAttachments: (taskId, files) => {
      uploads.push({ taskId, names: files.map((f) => f.name) });
      return Promise.resolve();
    },
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Attach' }).disabled
  ).toBe(false);
  fireEvent.change(attachInput(), {
    target: {
      files: [new File(['a'], 'spec.png'), new File(['b'], 'notes.txt')],
    },
  });
  const pills = document.querySelector('[data-slot="pending-attachments"]');
  expect(pills?.textContent).toContain('spec.png');
  expect(pills?.textContent).toContain('notes.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
  expect(
    document.querySelector('[data-slot="pending-attachments"]')?.textContent
  ).not.toContain('notes.txt');

  fireEvent.change(titleField(), { target: { value: 'With a file' } });
  fireEvent.click(createButton());
  await settle();

  expect(uploads).toEqual([{ taskId: 't-new001', names: ['spec.png'] }]);
  expect(closed()).toBe(1);
});

test('a failed upload toasts per file and the task still counts as created', async () => {
  const { created, closed } = mount({
    onUploadAttachments: () => Promise.reject(new Error('disk full')),
  });
  fireEvent.change(attachInput(), {
    target: { files: [new File(['a'], 'spec.png')] },
  });
  fireEvent.change(titleField(), { target: { value: 'Still created' } });
  fireEvent.click(createButton());
  await settle();

  expect(created).toHaveLength(1);
  expect(closed()).toBe(1);
  expect(await screen.findByText('Could not attach spec.png')).toBeTruthy();
  expect(await screen.findByText('disk full')).toBeTruthy();
});

// `withActionFeedback` resolves a failed create to `undefined` after toasting
// it, so the dialog must not read that as success and throw the draft away.
test('a create that resolves without a doc keeps the dialog, draft and files', async () => {
  const uploads: string[] = [];
  const { closed } = mount({
    onCreate: () => Promise.resolve(undefined),
    onUploadAttachments: (taskId) => {
      uploads.push(taskId);
      return Promise.resolve();
    },
  });
  fireEvent.change(attachInput(), {
    target: { files: [new File(['a'], 'spec.png')] },
  });
  fireEvent.change(titleField(), { target: { value: 'Swallowed' } });
  fireEvent.click(createButton());
  await settle();
  expect(uploads).toEqual([]);
  expect(closed()).toBe(0);
  expect(titleField().value).toBe('Swallowed');
  expect(screen.getByRole('button', { name: 'Remove spec.png' })).toBeTruthy();
});
