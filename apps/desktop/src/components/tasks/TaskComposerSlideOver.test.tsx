import type {
  CreateInput,
  LabelDefinition,
  TaskDoc,
} from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { useState } from 'react';

import { useGlobalKeyboard } from '../../hooks/useGlobalKeyboard';
import { BRAIN_DUMP_DRAFT_KEY } from '../../hooks/usePersistedDraft';
import type { GlobalKeyCommand } from '../../lib/keyboard';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../shell/ShellActionsContext';
import { ToastProvider } from '../shell/Toasts';
import {
  type ComposerMode,
  CREATE_TASK_DESCRIPTION_KEY,
  CREATE_TASK_TITLE_KEY,
  TaskComposerSlideOver,
} from './TaskComposerSlideOver';

const STATUSES = ['draft', 'ready', 'working', 'review', 'landed'];

// The title, description and brain-dump draft persist to localStorage; one test's typing
// must not leak into the next mount.
beforeEach(() => {
  window.localStorage.removeItem(CREATE_TASK_TITLE_KEY);
  window.localStorage.removeItem(CREATE_TASK_DESCRIPTION_KEY);
  window.localStorage.removeItem(BRAIN_DUMP_DRAFT_KEY);
});

function epic(id: string, title: string, kind = 'milestone'): TaskDoc {
  return {
    meta: { id, title, kind, icon: null, color: null, labels: [] },
    body: '',
  } as unknown as TaskDoc;
}

const EPICS = [
  epic('e-1', 'Search index'),
  epic('p-1', 'Platform', 'project'),
  epic('t-9', 'Parent issue', 'task'),
  epic('m-2', 'Payments › Beta'),
];

// What a successful `handleCreate` resolves with: enough of a doc for the composer to
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
    openOverseer: unexpected,
    setProjectView: unexpected,
    setGlobalView: unexpected,
    openShortcuts: unexpected,
    copyTaskId: unexpected,
  };
}

interface MountOptions {
  mode?: ComposerMode;
  open?: boolean;
  preset?: CreateTaskPreset | null;
  projectName?: string;
  labels?: readonly string[];
  labelDefinitions?: readonly LabelDefinition[];
  onCreate?: (input: CreateInput) => Promise<TaskDoc | null | undefined>;
  onUploadAttachments?: (taskId: string, files: File[]) => Promise<void>;
  onDraft?: (
    prompt: string,
    options?: { parent?: string | null }
  ) => Promise<DraftRecord>;
  onCapture?: ((text: string) => Promise<void>) | null;
  daemonDown?: boolean;
  keyboard?: boolean;
}

// App's role: owns `open` and `mode` (an opener button stands in for `c`, ⌘D and the
// palette), and optionally mounts the global key owner so the modal's muting is real.
function Harness({
  options,
  record,
}: {
  options: MountOptions;
  record: {
    created: CreateInput[];
    drafts: [string, { parent?: string | null } | undefined][];
    commands: GlobalKeyCommand[];
    closed: number;
  };
}) {
  const [open, setOpen] = useState(options.open ?? true);
  const [mode, setMode] = useState<ComposerMode>(options.mode ?? 'quick');
  const onCreate =
    options.onCreate ?? (() => Promise.resolve(createdDoc('t-new001')));
  const onCapture =
    options.onCapture === null
      ? undefined
      : (options.onCapture ?? (() => Promise.resolve()));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open composer
      </button>
      {options.keyboard === true && (
        <KeyboardOwner onCommand={(command) => record.commands.push(command)} />
      )}
      <TaskComposerSlideOver
        open={open}
        mode={mode}
        onModeChange={setMode}
        statuses={STATUSES}
        epics={EPICS}
        labels={options.labels ?? []}
        labelDefinitions={options.labelDefinitions}
        projectName={options.projectName}
        onCreate={(input) => {
          record.created.push(input);
          return onCreate(input);
        }}
        onDraft={(prompt, draftOptions) => {
          record.drafts.push([prompt, draftOptions]);
          return options.onDraft === undefined
            ? Promise.resolve({ id: 'd-1' } as DraftRecord)
            : options.onDraft(prompt, draftOptions);
        }}
        onCapture={onCapture}
        onUploadAttachments={options.onUploadAttachments}
        daemon={
          options.daemonDown === true
            ? { starting: false, errorDetail: null, onRetry: () => {} }
            : null
        }
        onClose={() => {
          record.closed += 1;
          setOpen(false);
        }}
      />
    </>
  );
}

function KeyboardOwner({
  onCommand,
}: {
  onCommand: (command: GlobalKeyCommand) => void;
}) {
  useGlobalKeyboard({ onCommand });
  return null;
}

function mount(options: MountOptions = {}) {
  const record = {
    created: [] as CreateInput[],
    drafts: [] as [string, { parent?: string | null } | undefined][],
    commands: [] as GlobalKeyCommand[],
    closed: 0,
  };
  render(
    <ToastProvider>
      <ShellActionsProvider value={shellActions(options.preset ?? null)}>
        <Harness options={options} record={record} />
      </ShellActionsProvider>
    </ToastProvider>
  );
  return {
    created: record.created,
    drafts: record.drafts,
    commands: record.commands,
    closed: () => record.closed,
  };
}

/** The open composer: "New task" in Describe and Quick add, "Quick capture" in Drop a
 * thought. */
function composer() {
  return screen.queryByRole('dialog', { name: /^(New task|Quick capture)$/ });
}

/** The focused element as "<tag> <aria-label>" ("body" when focus fell out), so a failed
 * focus assertion reads as a name rather than a DOM dump. */
function focused() {
  const el = document.activeElement;
  if (el === null || el === document.body) return 'body';
  const role = el.getAttribute('role');
  const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
  return `${el.tagName.toLowerCase()}${role === null ? '' : `[${role}]`} ${role === 'dialog' ? '' : name}`.trim();
}

/** One macrotask: the slide-over's focus guard checks a tick after focus is lost. */
async function tick() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** What Chrome does to a focused control that turns disabled or unmounts: focus falls to
 * <body> with nowhere to go (happy-dom keeps it on the control). */
function dropFocus() {
  act(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return;
    // happy-dom will not blur a disabled button (a busy one); Chrome's focus fixup does.
    const disabled = el instanceof HTMLButtonElement && el.disabled;
    if (el instanceof HTMLButtonElement) el.disabled = false;
    el.blur();
    if (el instanceof HTMLButtonElement) el.disabled = disabled;
  });
  expect(focused()).toBe('body');
}

/** Queries scoped to the open composer (the toast region holds its own alert role). */
function inComposer() {
  const dialog = composer();
  if (dialog === null) throw new Error('composer not open');
  return within(dialog);
}

function attachInput() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input mounted');
  return input;
}

function titleField() {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Task title' });
}

function createButton() {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Create task' });
}

/** A picker's trigger, by its name: "Status: Draft". */
function trigger(name: string) {
  return screen.getByRole<HTMLButtonElement>('button', { name });
}

function optionTexts() {
  return screen.getAllByRole('option').map((option) => option.textContent);
}

async function settle() {
  await act(async () => {});
}

// ---- Quick add (the old CreateTaskModal) --------------------------------

test('a modal dialog named New task with the crumb, fields and property pickers', () => {
  mount();
  const dialog = composer();
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  // The dialog-chrome Expand is gone with the dialog.
  expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();

  const title = titleField();
  expect(title.classList.contains('input')).toBe(true);
  expect(title.placeholder).toBe('Task title');
  const description = screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Description',
  });
  expect(description.classList.contains('textarea')).toBe(true);
  expect(description.placeholder).toBe('Add description…');

  // The pickers' triggers read their property and value.
  expect(trigger('Status: Draft')).toBeTruthy();
  expect(trigger('Priority: No priority')).toBeTruthy();
  expect(trigger('Assignee: Unassigned')).toBeTruthy();
  expect(trigger('Kind: Task')).toBeTruthy();
  expect(trigger('Parent: No parent')).toBeTruthy();
  expect(trigger('Labels: Add label')).toBeTruthy();

  // No Cancel; the footer's switch and actions.
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.getByRole('switch', { name: 'Create more' })).toBeTruthy();
});

test('reads the status and the parent container from the shell createPreset', async () => {
  const { created } = mount({ preset: { status: 'review', epic: 'e-1' } });
  expect(trigger('Status: Review')).toBeTruthy();
  expect(trigger('Parent: Search index')).toBeTruthy();
  // The free-text milestone is gone: a task's container is its parent.
  expect(screen.queryByRole('button', { name: /^Milestone/ })).toBeNull();

  fireEvent.change(titleField(), { target: { value: 'Ship it' } });
  fireEvent.click(createButton());
  await settle();

  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    title: 'Ship it',
    status: 'review',
    parent: 'e-1',
  });
  expect(created[0]).not.toHaveProperty('milestone');
});

test('the Parent picker lists where this kind can live, and clears to no parent', async () => {
  const { created } = mount({ preset: { epic: 'e-1' } });
  fireEvent.click(trigger('Parent: Search index'));
  expect(optionTexts()).toEqual([
    'No parent',
    'Search indexMilestone',
    'PlatformProject',
    'Payments › BetaMilestone',
    'Parent issueTask',
  ]);
  // Each container wears its kind's glyph.
  expect(
    within(screen.getByRole('listbox', { name: 'Parent' }))
      .getAllByRole('option')[1]
      ?.querySelector('[data-slot="container-icon"]')
  ).not.toBeNull();
  fireEvent.click(screen.getByRole('option', { name: /No parent/ }));
  expect(trigger('Parent: No parent')).toBeTruthy();

  fireEvent.change(titleField(), { target: { value: 'Loose' } });
  fireEvent.click(createButton());
  await settle();
  expect(created[0]).toMatchObject({ parent: null });
});

test('a kind preset starts the Kind picker there and creates that kind', async () => {
  const { created } = mount({ preset: { kind: 'project' } });
  expect(trigger('Kind: Project')).toBeTruthy();
  fireEvent.change(titleField(), { target: { value: 'Payments' } });
  fireEvent.click(createButton());
  await settle();
  expect(created[0]).toMatchObject({ title: 'Payments', kind: 'project' });
});

test('switching to a broader kind drops a parent that cannot hold it', () => {
  mount({ preset: { epic: 'e-1' } });
  fireEvent.click(trigger('Kind: Task'));
  fireEvent.click(screen.getByRole('option', { name: /Project/ }));
  expect(trigger('Kind: Project')).toBeTruthy();
  expect(trigger('Parent: No parent')).toBeTruthy();
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

test('Ctrl+⏎ creates from the description too', async () => {
  const { created } = mount();
  fireEvent.change(titleField(), { target: { value: 'From the body' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Description' }), {
    key: 'Enter',
    ctrlKey: true,
  });
  await settle();
  expect(created).toHaveLength(1);
});

test('Create more keeps the panel open and clears title and description', async () => {
  const { created, closed } = mount();
  const toggle = screen.getByRole('switch', { name: 'Create more' });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.change(titleField(), { target: { value: 'First' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
    target: { value: 'body' },
  });
  fireEvent.click(createButton());
  await settle();

  expect(created).toHaveLength(1);
  expect(closed()).toBe(0);
  expect(titleField().value).toBe('');
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' })
      .value
  ).toBe('');
  // The properties survive for the next task.
  expect(trigger('Status: Draft')).toBeTruthy();
});

test('a landed Create more puts focus in the cleared title, by click or by Save as draft', async () => {
  const { created } = mount();
  fireEvent.click(screen.getByRole('switch', { name: 'Create more' }));
  fireEvent.change(titleField(), { target: { value: 'First' } });
  const create = createButton();
  act(() => create.focus());
  fireEvent.click(create);
  // The busy button drops focus in a browser; the landed create puts it in the title.
  dropFocus();
  await tick();
  await settle();
  expect(created).toHaveLength(1);
  expect(focused()).toBe('input Task title');

  // Save as draft unmounts once the title clears: focus is already in the title.
  fireEvent.change(titleField(), { target: { value: 'Second' } });
  const saveDraft = screen.getByRole('button', { name: 'Save as draft' });
  act(() => saveDraft.focus());
  fireEvent.click(saveDraft);
  await settle();
  expect(created).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull();
  expect(focused()).toBe('input Task title');
});

test('a create that does not land hands lost focus back to the title', async () => {
  let reject: (error: Error) => void = () => {};
  mount({
    onCreate: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  });
  fireEvent.change(titleField(), { target: { value: 'Keep me' } });
  const create = createButton();
  act(() => create.focus());
  fireEvent.click(create);
  dropFocus();
  await tick();
  // While the create runs, the slide-over holds the dropped focus on its panel.
  expect(focused()).toBe('div[dialog]');
  reject(new Error('daemon said no'));
  await settle();
  expect(focused()).toBe('input Task title');
});

test('⌘⏎ creates from the footer controls too, without pressing the focused one', async () => {
  const { created } = mount();
  fireEvent.change(titleField(), { target: { value: 'From the footer' } });
  const toggle = screen.getByRole('switch', { name: 'Create more' });
  // A document listener behind the modal (a task drawer's ⌘⏎) never sees it.
  const behind: string[] = [];
  const onKey = (event: KeyboardEvent) => behind.push(event.key);
  document.addEventListener('keydown', onKey);
  try {
    fireEvent.keyDown(toggle, { key: 'Enter', metaKey: true });
    await settle();
  } finally {
    document.removeEventListener('keydown', onKey);
  }
  expect(created.map((input) => input.title)).toEqual(['From the footer']);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(behind).toEqual([]);
});

test('Save as draft appears once a title exists and files the task as draft', async () => {
  const { created } = mount({ preset: { status: 'ready' } });
  expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull();

  fireEvent.change(titleField(), { target: { value: 'Later' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
  await settle();

  expect(created[0]?.status).toBe('draft');
});

test('a failed create keeps the panel open with the title intact and says why', async () => {
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

test('the crumb reads Dispatch until a project is open', () => {
  mount();
  expect(screen.getByText('Dispatch')).toBeTruthy();
});

test('the Labels picker lists the catalogue, swatches registry colours, and reads back on create', async () => {
  // Built from parts so the colour-literal guard does not read it as a hex of the file's own.
  const red = ['#', 'cc3344'].join('');
  const { created } = mount({
    labels: ['bug', 'auth'],
    labelDefinitions: [{ name: 'bug', color: red }],
  });
  await act(async () => {
    fireEvent.click(trigger('Labels: Add label'));
    await Promise.resolve();
  });
  expect(optionTexts()).toEqual(['auth', 'bug']);
  // Only the registry's hex colour is drawn; a label without one has no mark.
  const swatches = document.querySelectorAll<HTMLElement>(
    '[role="option"] [data-mark="swatch"]'
  );
  expect(swatches.length).toBe(1);
  expect(swatches[0]?.style.backgroundColor).not.toBe('');
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name: 'bug' }));
    await Promise.resolve();
  });
  // A multi-select: the picker stays open and the face reads the pick.
  expect(trigger('Labels: bug')).toBeTruthy();
  expect(screen.queryAllByRole('option').length).toBeGreaterThan(0);

  fireEvent.change(titleField(), { target: { value: 'Tagged' } });
  fireEvent.click(createButton());
  await settle();
  expect(created[0]?.labels).toEqual(['bug']);
});

test('the Labels picker makes a new label from the typed text', async () => {
  const { created } = mount({ labels: ['bug'] });
  fireEvent.click(trigger('Labels: Add label'));
  const search = screen.getByRole('combobox', { name: 'Labels' });
  fireEvent.change(search, { target: { value: 'perf' } });
  const createRow = screen.getByRole('option', { name: 'Create "perf"' });
  await act(async () => {
    fireEvent.click(createRow);
    await Promise.resolve();
  });
  // Chosen at once, listed from then on, and the search clears for the next one.
  expect(trigger('Labels: perf')).toBeTruthy();
  expect(
    screen.getByRole('option', { name: 'perf' }).getAttribute('aria-selected')
  ).toBe('true');
  expect(
    screen.getByRole<HTMLInputElement>('combobox', { name: 'Labels' }).value
  ).toBe('');

  fireEvent.change(titleField(), { target: { value: 'Faster' } });
  fireEvent.click(createButton());
  await settle();
  expect(created[0]?.labels).toEqual(['perf']);
});

test('the footer paperclip is disabled without an upload handler', () => {
  mount();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Attach' }).disabled
  ).toBe(true);
  expect(document.querySelector('input[type="file"]')).toBeNull();
});

test('pending files show as removable chips and upload against the created id', async () => {
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
  const chips = document.querySelector('[data-slot="pending-attachments"]');
  expect(chips?.textContent).toContain('spec.png');
  expect(chips?.textContent).toContain('notes.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
  expect(
    document.querySelector('[data-slot="pending-attachments"]')?.textContent
  ).not.toContain('notes.txt');
  // The removed chip's button went with it: focus moves to the file left.
  expect(focused()).toBe('button Remove spec.png');

  fireEvent.change(titleField(), { target: { value: 'With a file' } });
  fireEvent.click(createButton());
  await settle();

  expect(uploads).toEqual([{ taskId: 't-new001', names: ['spec.png'] }]);
  expect(closed()).toBe(1);
});

test('removing the last pending file moves focus to Attach', () => {
  mount({ onUploadAttachments: () => Promise.resolve() });
  fireEvent.change(attachInput(), {
    target: { files: [new File(['a'], 'spec.png')] },
  });
  const remove = screen.getByRole('button', { name: 'Remove spec.png' });
  act(() => remove.focus());
  fireEvent.click(remove);
  expect(
    document.querySelector('[data-slot="pending-attachments"]')
  ).toBeNull();
  expect(focused()).toBe('button Attach');
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
// it, so the composer must not read that as success and throw the draft away.
test('a create that resolves without a doc keeps the panel, draft and files', async () => {
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

test('a pasted file joins the pending attachments', () => {
  mount({ onUploadAttachments: () => Promise.resolve() });
  const file = new File(['a'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(titleField(), {
    clipboardData: {
      files: [file],
      items: [{ kind: 'file', getAsFile: () => file }],
      types: ['Files'],
    },
  });
  expect(
    document.querySelector('[data-slot="pending-attachments"]')?.textContent
  ).toContain('shot.png');
});

// ---- Describe (the old AiTaskComposer) -----------------------------------

async function draft(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe the task' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: /Draft task/ }));
  // The submit awaits the start call; let it settle.
  await settle();
}

test("a container's + drafts the task inside it", async () => {
  const { drafts, closed } = mount({
    mode: 'describe',
    preset: { epic: 'm-2' },
  });
  expect(document.querySelector('[data-slot=draft-parent]')?.textContent).toBe(
    'In Payments › Beta'
  );
  await draft('add refunds');
  expect(drafts).toEqual([['add refunds', { parent: 'm-2' }]]);
  expect(closed()).toBe(1);
});

test('the parent chip can be dropped before drafting', async () => {
  const { drafts } = mount({ mode: 'describe', preset: { epic: 'm-2' } });
  const notIn = screen.getByRole('button', { name: 'Not in Payments › Beta' });
  act(() => notIn.focus());
  fireEvent.click(notIn);
  expect(document.querySelector('[data-slot=draft-parent]')).toBeNull();
  // The button went with the chip: focus is in the prompt, not on <body>.
  expect(focused()).toBe('textarea Describe the task');
  await draft('add refunds');
  expect(drafts).toEqual([['add refunds', undefined]]);
});

test('without a preset nothing is pinned', async () => {
  const { drafts } = mount({ mode: 'describe' });
  expect(document.querySelector('[data-slot=draft-parent]')).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: /Draft task/ })
      .disabled
  ).toBe(true);
  await draft('add refunds');
  expect(drafts).toEqual([['add refunds', undefined]]);
});

test('Quick add carries the parent the composer still holds', () => {
  mount({ mode: 'describe', preset: { status: 'ready', epic: 'm-2' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Quick add' }));
  expect(trigger('Parent: Payments › Beta')).toBeTruthy();
  expect(trigger('Status: Ready')).toBeTruthy();
});

test('a dropped parent chip stays dropped in Quick add', () => {
  mount({ mode: 'describe', preset: { status: 'ready', epic: 'm-2' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Not in Payments › Beta' })
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Quick add' }));
  expect(trigger('Parent: No parent')).toBeTruthy();
});

test('the prompt stays focusable while a draft starts', async () => {
  let release: () => void = () => {};
  mount({
    mode: 'describe',
    onDraft: () =>
      new Promise<DraftRecord>((resolve) => {
        release = () => resolve({ id: 'd-1' } as DraftRecord);
      }),
  });
  const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Describe the task',
  });
  fireEvent.change(prompt, { target: { value: 'by keyboard' } });
  fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
  // Read-only, not disabled: a disabled field would drop focus to <body>.
  expect(prompt.readOnly).toBe(true);
  expect(prompt.disabled).toBe(false);
  expect(prompt.getAttribute('aria-busy')).toBe('true');
  release();
  await settle();
});

test('a failed draft keeps the prompt and says why', async () => {
  const { closed } = mount({
    mode: 'describe',
    onDraft: () => Promise.reject(new Error('planner offline')),
  });
  const draftButton = screen.getByRole('button', { name: /Draft task/ });
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe the task' }), {
    target: { value: 'keep this' },
  });
  act(() => draftButton.focus());
  fireEvent.click(draftButton);
  dropFocus();
  await tick();
  await settle();
  // Focus the busy button dropped is back in the prompt.
  expect(focused()).toBe('textarea Describe the task');
  expect(closed()).toBe(0);
  expect(inComposer().getByRole('alert').textContent).toBe('planner offline');
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Describe the task',
    }).value
  ).toBe('keep this');
});

test('⌘⏎ drafts from the prompt', async () => {
  const { drafts } = mount({ mode: 'describe' });
  const prompt = screen.getByRole('textbox', { name: 'Describe the task' });
  fireEvent.change(prompt, { target: { value: 'by keyboard' } });
  fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
  await settle();
  expect(drafts).toEqual([['by keyboard', undefined]]);
});

test('with the daemon down Describe shows the unavailable state and no Draft task', () => {
  mount({ mode: 'describe', daemonDown: true });
  expect(
    screen.queryByRole('textbox', { name: 'Describe the task' })
  ).toBeNull();
  expect(screen.queryByRole('button', { name: /Draft task/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
});

// ---- Modes ------------------------------------------------------------------

test('the Mode control switches forms and keeps what each one holds', () => {
  mount({ mode: 'describe' });
  expect(
    screen
      .getByRole('radiogroup', { name: 'Mode' })
      .querySelectorAll('[role="radio"]').length
  ).toBe(3);
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe the task' }), {
    target: { value: 'half a thought' },
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Quick add' }));
  expect(
    screen
      .getByRole('radio', { name: 'Quick add' })
      .getAttribute('aria-checked')
  ).toBe('true');
  fireEvent.change(titleField(), { target: { value: 'A title' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Describe' }));
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Describe the task',
    }).value
  ).toBe('half a thought');
  fireEvent.click(screen.getByRole('radio', { name: 'Quick add' }));
  expect(titleField().value).toBe('A title');
});

test('without a capture handler the third mode is not offered', () => {
  mount({ mode: 'describe', onCapture: null });
  expect(screen.queryByRole('radio', { name: 'Drop a thought' })).toBeNull();
  expect(screen.getAllByRole('radio')).toHaveLength(2);
});

test('a reopened composer starts from the new session, keeping only the persisted drafts', () => {
  mount({ mode: 'quick', preset: { epic: 'e-1' } });
  fireEvent.change(titleField(), { target: { value: 'Persisted' } });
  fireEvent.click(trigger('Kind: Task'));
  fireEvent.click(screen.getByRole('option', { name: /Milestone/ }));
  expect(trigger('Kind: Milestone')).toBeTruthy();
  fireEvent.keyDown(titleField(), { key: 'Escape' });
  expect(composer()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open composer' }));
  expect(titleField().value).toBe('Persisted');
  expect(trigger('Kind: Task')).toBeTruthy();
});

// ---- Keyboard and layers ----------------------------------------------------

test('while open, c, j, k, g and digits produce no global command', () => {
  const { commands } = mount({ keyboard: true, open: false });
  // Closed, the same keys reach the global owner (the control case).
  fireEvent.keyDown(document.body, { key: 'c' });
  expect(commands).toEqual(['new-task']);
  commands.length = 0;

  fireEvent.click(screen.getByRole('button', { name: 'Open composer' }));
  expect(composer()?.getAttribute('aria-modal')).toBe('true');
  // From the panel itself, not a text field, so only the modal check mutes them.
  const panel = composer();
  if (panel === null) throw new Error('composer not open');
  panel.focus();
  for (const key of ['c', 'j', 'k', 'g', 'p', '1', '2', '[', '?']) {
    fireEvent.keyDown(panel, { key });
  }
  expect(commands).toEqual([]);
  expect(composer()).not.toBeNull();
});

test('Escape on an open picker closes only the picker', () => {
  const { closed } = mount();
  fireEvent.click(trigger('Status: Draft'));
  const search = screen.getByRole('combobox', { name: 'Status' });
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(screen.queryByRole('listbox', { name: 'Status' })).toBeNull();
  expect(composer()).not.toBeNull();
  expect(closed()).toBe(0);

  // A second Escape, now from the panel, closes the composer.
  fireEvent.keyDown(trigger('Status: Draft'), { key: 'Escape' });
  expect(closed()).toBe(1);
});

test('⌘⏎ inside an open picker is the picker’s, not a create', async () => {
  const { created } = mount();
  fireEvent.change(titleField(), { target: { value: 'Not yet' } });
  fireEvent.click(trigger('Status: Draft'));
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Status' }), {
    key: 'Enter',
    metaKey: true,
  });
  await settle();
  expect(created).toEqual([]);
});

// ---- Drop a thought (the old QuickCaptureDialog) ----------------------------

function captureField() {
  return screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Quick capture',
  });
}

test('the capture mode opens straight into its box', () => {
  mount({ mode: 'capture', open: false });
  expect(composer()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open composer' }));
  expect(composer()).not.toBeNull();
  expect(document.activeElement).toBe(captureField());
  expect(captureField().placeholder).toBe('Dump it here…');
});

test('Drop a thought keeps the quick capture name and Notes crumb; the others say New task', () => {
  mount({ mode: 'capture', projectName: 'Audiobook' });
  const dialog = screen.getByRole('dialog', { name: 'Quick capture' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(within(dialog).getByText('Notes')).toBeTruthy();
  expect(within(dialog).queryByText('Audiobook')).toBeNull();
  // The box is described by where a thought goes.
  const hintId = captureField().getAttribute('aria-describedby');
  expect(
    hintId === null ? null : document.getElementById(hintId)?.textContent
  ).toContain('Notes inbox');
  fireEvent.click(screen.getByRole('radio', { name: 'Quick add' }));
  const quickAdd = screen.getByRole('dialog', { name: 'New task' });
  expect(within(quickAdd).getByText('Audiobook')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Describe' }));
  expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy();
});

test('capturing hands the draft to onCapture, then clears and closes', async () => {
  const captured: string[] = [];
  mount({
    mode: 'capture',
    onCapture: (text) => {
      captured.push(text);
      return Promise.resolve();
    },
  });
  fireEvent.change(captureField(), { target: { value: 'fix the flaky test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Drop it' }));
  await settle();
  expect(captured).toEqual(['fix the flaky test']);
  expect(composer()).toBeNull();
  // Reopening starts fresh — the landed draft is gone.
  fireEvent.click(screen.getByRole('button', { name: 'Open composer' }));
  expect(captureField().value).toBe('');
});

test('⌘⏎ commits the draft from the textarea', async () => {
  const captured: string[] = [];
  mount({
    mode: 'capture',
    onCapture: (text) => {
      captured.push(text);
      return Promise.resolve();
    },
  });
  fireEvent.change(captureField(), { target: { value: 'an idea' } });
  fireEvent.keyDown(captureField(), { key: 'Enter', metaKey: true });
  await waitFor(() => expect(captured).toEqual(['an idea']));
});

test('a second ⌘⏎ while a capture is in flight does not double-capture', async () => {
  let release: () => void = () => {};
  const captured: string[] = [];
  mount({
    mode: 'capture',
    onCapture: (text) => {
      captured.push(text);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  fireEvent.change(captureField(), { target: { value: 'once' } });
  fireEvent.keyDown(captureField(), { key: 'Enter', metaKey: true });
  fireEvent.keyDown(captureField(), { key: 'Enter', metaKey: true });
  expect(captured).toEqual(['once']);
  release();
  await settle();
  expect(composer()).toBeNull();
});

test('a failed capture keeps the draft and shows the error inline', async () => {
  mount({
    mode: 'capture',
    onCapture: () => Promise.reject(new Error('daemon said no')),
  });
  fireEvent.change(captureField(), { target: { value: 'do not lose me' } });
  const dropIt = screen.getByRole('button', { name: 'Drop it' });
  act(() => dropIt.focus());
  fireEvent.click(dropIt);
  dropFocus();
  await tick();
  await settle();
  // The busy Drop it dropped focus; it is back in the box.
  expect(focused()).toBe('textarea Quick capture');
  expect(inComposer().getByRole('alert').textContent).toBe('daemon said no');
  expect(composer()).not.toBeNull();
  expect(captureField().value).toBe('do not lose me');
});

test('the Drop it button is disabled while the draft is blank', () => {
  mount({ mode: 'capture' });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Drop it' }).disabled
  ).toBe(true);
});

test('Escape closes the composer', () => {
  mount({ mode: 'capture' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(composer()).toBeNull();
});
