import type { TaskDoc, UpdatePatch } from '@dispatch-foo/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';

import { testConfig } from '../components/settings/fixtures.test-helper';
import { useGlobalKeyboard } from '../hooks/useGlobalKeyboard';
import type { GlobalKeyCommand } from '../lib/keyboard';
import { DEFAULT_TASKS_DISPLAY, type TaskProperty } from '../lib/tasksPrefs';
import {
  handleTaskListKeyDown,
  type ListRowPassthrough,
  type OpenPicker,
  TaskListRow,
} from './TaskListRow';

function task(id: string, title: string, labels: string[] = []): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      priority: 'medium',
      parent: null,
      milestone: null,
      labels,
      assignee: 'none',
      blockedBy: [],
      writes: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

const TASKS = [
  task('t-1', 'Cache the index', ['ui']),
  task('t-2', 'Ship the pass', ['api', 'infra']),
];

const noop = () => {};
const resolved = () => Promise.resolve();
const NO_EPICS: TaskDoc[] = [];
const LABELS = [...new Set(TASKS.flatMap((t) => t.meta.labels))].sort();

// A popover positions itself a microtask after mount (floating-ui), so anything that opens
// or drives one runs inside an async `act` that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

/** The two rows inside a `role="grid"` container wired to `handleTaskListKeyDown`, with the
 * picker and cursor state a list view would own. */
function Grid({
  updates,
  cursor,
  rowProps,
}: {
  updates: [string, unknown][];
  cursor: string[];
  rowProps?: ListRowPassthrough;
}) {
  const [picker, setPicker] = useState<OpenPicker | null>(null);
  const [focusedTaskId, setFocused] = useState<string | null>('t-1');
  const onUpdate = (id: string, patch: UpdatePatch) => {
    updates.push([id, patch]);
    return Promise.resolve();
  };
  return (
    <div
      role="grid"
      data-slot="grid"
      onKeyDown={(e) =>
        handleTaskListKeyDown(e, {
          orderedIds: TASKS.map((t) => t.meta.id),
          focusedTaskId,
          setFocusedTaskId: (id) => {
            cursor.push(id ?? '');
            setFocused(id);
          },
          onOpen: () => {},
          onPeek: () => {},
          setPicker,
          onEscape: () => false,
        })
      }
    >
      {TASKS.map((doc) => (
        <TaskListRow
          key={doc.meta.id}
          doc={doc}
          prefs={DEFAULT_TASKS_DISPLAY}
          run={undefined}
          live={false}
          needsYou={false}
          statuses={testConfig.statuses}
          epics={NO_EPICS}
          labelCandidates={LABELS}
          onUpdate={onUpdate}
          onMoveStatus={resolved}
          picker={picker}
          onPickerChange={setPicker}
          selected={false}
          focused={focusedTaskId === doc.meta.id}
          onOpen={noop}
          onFocus={noop}
          rowProps={rowProps}
        />
      ))}
    </div>
  );
}

function grid(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot=grid]');
  if (el === null) throw new Error('no grid');
  return el;
}

function rows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot=list-row]')
  );
}

test('l on the focused row mounts the label picker over the project vocabulary', async () => {
  render(<Grid updates={[]} cursor={[]} />);
  expect(screen.queryByRole('button', { name: 'Change labels' })).toBeNull();
  await settle(() => {
    fireEvent.keyDown(grid(), { key: 'l' });
  });
  // The trigger sits in the focused row's trailing group, after its pills.
  const trigger = screen.getByRole('button', { name: 'Change labels' });
  expect(rows()[0]?.contains(trigger)).toBe(true);
  expect(screen.getByPlaceholderText('Label…')).not.toBeNull();
  const options = screen.getAllByRole('option').map((o) => ({
    label: o.textContent,
    checked: o.querySelector('svg.lucide-check') !== null,
  }));
  expect(options).toEqual([
    { label: 'api', checked: false },
    { label: 'infra', checked: false },
    { label: 'ui', checked: true },
  ]);
});

test('toggling a label patches the whole list and leaves the picker open', async () => {
  const updates: [string, unknown][] = [];
  render(<Grid updates={updates} cursor={[]} />);
  await settle(() => {
    fireEvent.keyDown(grid(), { key: 'l' });
  });
  await settle(() => {
    const option = screen.getByRole('option', { name: /^api$/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
  expect(updates).toEqual([['t-1', { labels: ['ui', 'api'] }]]);
  expect(screen.getByPlaceholderText('Label…')).not.toBeNull();
});

test('j typed in the picker search does not move the cursor', async () => {
  const cursor: string[] = [];
  render(<Grid updates={[]} cursor={cursor} />);
  await settle(() => {
    fireEvent.keyDown(grid(), { key: 'l' });
  });
  const input = screen.getByPlaceholderText('Label…');
  await settle(() => {
    fireEvent.keyDown(input, { key: 'j' });
  });
  expect(cursor).toEqual([]);
  expect(rows()[0]?.dataset['focused']).toBe('true');
  // The bare key on the grid itself still moves it.
  fireEvent.keyDown(grid(), { key: 'j' });
  expect(cursor).toEqual(['t-2']);
});

test('rowProps land on the row element', () => {
  render(
    <Grid
      updates={[]}
      cursor={[]}
      rowProps={{ 'data-probe': 'x' } as ListRowPassthrough}
    />
  );
  for (const row of rows()) {
    expect(row.dataset['probe']).toBe('x');
  }
  expect(rows()[0]?.dataset['rowId']).toBe('t-1');
});

// Rows are memo'd with id-based callbacks, so hovering one re-renders only the rows whose
// `focused` flipped. Render work is counted through `prefs.properties.has`, which every
// row render calls a fixed number of times.
test('a cursor move re-renders only the rows whose focus changed', () => {
  let reads = 0;
  class CountingSet extends Set<TaskProperty> {
    override has(value: TaskProperty): boolean {
      reads += 1;
      return super.has(value);
    }
  }
  const prefs = {
    ...DEFAULT_TASKS_DISPLAY,
    properties: new CountingSet(DEFAULT_TASKS_DISPLAY.properties),
  };
  const docs = ['t-1', 't-2', 't-3', 't-4', 't-5'].map((id) => task(id, id));
  function List() {
    const [focused, setFocused] = useState<string | null>(null);
    return (
      <div>
        {docs.map((doc) => (
          <TaskListRow
            key={doc.meta.id}
            doc={doc}
            prefs={prefs}
            run={undefined}
            live={false}
            needsYou={false}
            statuses={testConfig.statuses}
            epics={NO_EPICS}
            onUpdate={resolved}
            onMoveStatus={resolved}
            picker={null}
            onPickerChange={noop}
            selected={false}
            focused={focused === doc.meta.id}
            onOpen={noop}
            onFocus={setFocused}
            rowProps={{ 'data-probe': doc.meta.id } as ListRowPassthrough}
          />
        ))}
      </div>
    );
  }
  render(<List />);
  const perRow = reads / docs.length;
  expect(perRow).toBeGreaterThan(0);

  reads = 0;
  fireEvent.mouseEnter(rows()[2]);
  expect(reads).toBe(perRow);

  reads = 0;
  fireEvent.mouseEnter(rows()[3]);
  expect(reads).toBe(perRow * 2);
});

test('a task whose run is in the merge queue carries the Landing badge', () => {
  const props = {
    prefs: DEFAULT_TASKS_DISPLAY,
    run: undefined,
    live: false,
    needsYou: false,
    statuses: testConfig.statuses,
    epics: NO_EPICS,
    onUpdate: resolved,
    onMoveStatus: resolved,
    picker: null,
    onPickerChange: noop,
    selected: false,
    focused: false,
    onOpen: noop,
    onFocus: noop,
  };
  render(
    <div>
      <TaskListRow {...props} doc={task('t-1', 'Landing')} landing="merging" />
      <TaskListRow {...props} doc={task('t-2', 'Idle')} />
    </div>
  );
  const badges = document.querySelectorAll('[data-slot=landing-badge]');
  expect(badges).toHaveLength(1);
  expect(badges[0]?.closest('[data-row-id]')?.getAttribute('data-row-id')).toBe(
    't-1'
  );
  expect(badges[0]?.getAttribute('title')).toBe('Landing · merging');
});

// A focused list under the shell's window listener: the list's own `f` opens its filter,
// `s` and `a` its pickers.
function ChordHarness({
  commands,
  local,
}: {
  commands: GlobalKeyCommand[];
  local: string[];
}) {
  useGlobalKeyboard({ onCommand: (c) => commands.push(c) });
  return (
    <div
      data-testid="list"
      tabIndex={0}
      onKeyDown={(e) =>
        handleTaskListKeyDown(e, {
          orderedIds: ['t-1'],
          focusedTaskId: 't-1',
          setFocusedTaskId: () => {},
          onOpen: () => {},
          onPeek: () => {},
          setPicker: (picker) => {
            if (picker !== null) local.push(picker.kind);
          },
          onEscape: () => false,
          onRequestFilter: () => local.push('filter'),
        })
      }
    />
  );
}

test('a g chord’s second key goes to the shell, not the focused list', () => {
  const commands: GlobalKeyCommand[] = [];
  const local: string[] = [];
  render(<ChordHarness commands={commands} local={local} />);
  const list = screen.getByTestId('list');
  list.focus();
  for (const key of ['f', 's', 'a']) {
    fireEvent.keyDown(list, { key: 'g' });
    fireEvent.keyDown(list, { key });
  }
  expect({ commands, local }).toEqual({
    commands: ['goto-live', 'goto-settings', 'goto-overseer'],
    local: [],
  });
  // Outside a chord the keys are the list's again.
  fireEvent.keyDown(list, { key: 'f' });
  expect(local).toEqual(['filter']);
});
