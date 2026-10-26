import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  AssigneePicker,
  EstimatePicker,
  LabelPicker,
  MilestonePicker,
  PriorityPicker,
  ProjectPicker,
  StatePicker,
  type TaskPriority,
  TaskRelationPicker,
  type TaskSearchResult,
} from '../src/index';

afterEach(cleanup);

// The property presets map plain choices onto PickerPopover options, and
// TaskRelationPicker searches through the host. Behaviour shared with
// PickerPopover is covered in edit-picker.test.tsx.

function combobox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox');
}

/** Each option's text without its decorative marks (initials, glyphs). */
function optionNames(): string[] {
  return within(screen.getByRole('listbox'))
    .queryAllByRole('option')
    .map((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
        hidden.remove();
      }
      return copy.textContent ?? '';
    });
}

async function pick(name: RegExp | string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name }));
    await Promise.resolve();
  });
}

describe('StatePicker', () => {
  const STATES = [
    { id: 's-todo', name: 'Todo', kind: 'unstarted' as const },
    { id: 's-doing', name: 'In Progress', kind: 'started' as const },
    { id: 's-done', name: 'Done', kind: 'completed' as const },
  ];

  test('state glyphs, no none option, the bordered pill (mono) by default, ids out', async () => {
    const onChange = mock((_id: string) => undefined);
    render(<StatePicker states={STATES} value="s-todo" onChange={onChange} />);
    const button = screen.getByRole('button', { name: 'Status: Todo' });
    expect(button.getAttribute('data-appearance')).toBe('mono');
    expect(button.querySelector('[data-kind="unstarted"]')).not.toBeNull();
    fireEvent.click(button);
    expect(combobox().placeholder).toBe('Change status…');
    expect(optionNames()).toEqual(['Todo', 'In Progress', 'Done']);
    await pick('Done');
    expect(onChange).toHaveBeenCalledWith('s-done');
  });
});

describe('AssigneePicker', () => {
  const PEOPLE = [
    { id: 'u-ana', name: 'Ana Moreno' },
    { id: 'u-ben', name: 'Ben Okafor', keywords: ['ben@northwind.test'] },
  ];

  test('round avatars, "You", Unassigned in the warning tone', async () => {
    const onChange = mock((_id: string | null) => undefined);
    render(
      <AssigneePicker
        people={PEOPLE}
        value={null}
        meId="u-ben"
        onChange={onChange}
      />
    );
    const button = screen.getByRole('button', {
      name: 'Assignee: Unassigned',
    });
    expect(button.querySelector('[data-tone="warning"]')?.textContent).toBe(
      'Unassigned'
    );
    // Nobody is the dashed empty avatar, on the face and the none option.
    expect(
      button.querySelector('[data-mark="avatar"]')?.getAttribute('data-empty')
    ).toBe('true');
    fireEvent.click(button);
    expect(optionNames()).toEqual([
      'Unassigned',
      'Ana Moreno',
      'Ben OkaforYou',
    ]);
    const anaAvatar = screen
      .getByRole('option', { name: /Ana Moreno/ })
      .querySelector('[data-mark="avatar"]');
    expect(anaAvatar?.textContent).toBe('AM');
    // A pastel hue picked from the name (decoration; the name is printed).
    expect(anaAvatar?.getAttribute('data-hue')).toMatch(
      /^(violet|teal|rose|orange)$/
    );
    fireEvent.change(combobox(), { target: { value: 'you' } });
    expect(optionNames()).toEqual(['Ben OkaforYou']);
    fireEvent.change(combobox(), { target: { value: 'northwind' } });
    expect(optionNames()).toEqual(['Ben OkaforYou']);
    await pick(/Ben Okafor/);
    expect(onChange).toHaveBeenCalledWith('u-ben');
  });

  test('a person may have a group heading and a mark of their own', () => {
    render(
      <AssigneePicker
        people={[
          ...PEOPLE,
          {
            id: 'agent-claude',
            name: 'Claude',
            group: 'Agents',
            mark: {
              kind: 'node',
              node: <svg data-mark="bot" aria-hidden="true" />,
            },
          },
        ]}
        value={null}
        onChange={() => undefined}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Assignee: Unassigned' })
    );
    // Ungrouped people first, then the group under its heading.
    expect(optionNames()).toEqual([
      'Unassigned',
      'Ana Moreno',
      'Ben Okafor',
      'Claude',
    ]);
    const group = screen.getByRole('group', { name: 'Agents' });
    const claude = within(group).getByRole('option', { name: 'Claude' });
    expect(claude.querySelector('[data-mark="bot"]')).not.toBeNull();
    expect(claude.querySelector('[data-mark="avatar"]')).toBeNull();
    // The others keep the avatar.
    expect(
      screen
        .getByRole('option', { name: /Ana Moreno/ })
        .querySelector('[data-mark="avatar"]')
    ).not.toBeNull();
  });

  test('a deactivated assignee is still named and listed', () => {
    render(
      <AssigneePicker
        people={PEOPLE}
        value="u-old"
        valueLabel="Old Person"
        onChange={() => undefined}
      />
    );
    const button = screen.getByRole('button', {
      name: 'Assignee: Old Person',
    });
    fireEvent.click(button);
    expect(optionNames()[1]).toBe('Old Person');
  });
});

describe('PriorityPicker', () => {
  test("Linear's five levels in its order, numbers out", async () => {
    function Host() {
      const [value, setValue] = useState<TaskPriority>(3);
      return <PriorityPicker value={value} onChange={setValue} />;
    }
    render(<Host />);
    const button = screen.getByRole('button', { name: 'Priority: Medium' });
    fireEvent.click(button);
    expect(optionNames()).toEqual([
      'No priority',
      'Urgent',
      'High',
      'Medium',
      'Low',
    ]);
    fireEvent.change(combobox(), { target: { value: 'urg' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(
      screen.getByRole('button', { name: 'Priority: Urgent' })
    ).toBeTruthy();
  });

  test('labels can be renamed', () => {
    render(
      <PriorityPicker
        value={0}
        priorityLabels={{ 0: 'None' }}
        onChange={() => undefined}
      />
    );
    expect(screen.getByRole('button', { name: 'Priority: None' })).toBeTruthy();
  });

  // The face's tone follows the value it shows, pending included: a list
  // cell's red "Urgent" (priorityTones) never colours a pending "High",
  // and a pending "Urgent" is red at once.
  test('a level’s tone colours the face while that level is shown', async () => {
    let finish: () => void = () => undefined;
    function Host() {
      const [value, setValue] = useState<TaskPriority>(1);
      return (
        <PriorityPicker
          value={value}
          priorityTones={{ 1: 'danger' }}
          onChange={(next) =>
            new Promise<void>((resolve) => {
              finish = () => {
                setValue(next);
                resolve();
              };
            })
          }
        />
      );
    }
    render(<Host />);
    const face = (name: string) =>
      within(screen.getByRole('button', { name: `Priority: ${name}` }))
        .getByText(name)
        .getAttribute('data-tone');
    expect(face('Urgent')).toBe('danger');
    fireEvent.click(screen.getByRole('button', { name: 'Priority: Urgent' }));
    fireEvent.change(combobox(), { target: { value: 'high' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    // Saving: the face shows High, untoned, before the host has it.
    expect(face('High')).toBeNull();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(face('High')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Priority: High' }));
    fireEvent.change(combobox(), { target: { value: 'urg' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    // Saving Urgent: red already.
    expect(face('Urgent')).toBe('danger');
  });
});

describe('LabelPicker', () => {
  const LABELS = [
    { id: 'l-bug', name: 'Bug', color: '#eb5757' },
    { id: 'l-search', name: 'search', color: '#4ea7fc' },
    {
      id: 'l-s',
      name: 'Small',
      group: { id: 'g-size', name: 'Size', singleSelect: true },
    },
    {
      id: 'l-l',
      name: 'Large',
      group: { id: 'g-size', name: 'Size', singleSelect: true },
    },
    {
      id: 'l-web',
      name: 'Web',
      group: { id: 'g-area', name: 'Area' },
    },
    {
      id: 'l-api',
      name: 'API',
      group: { id: 'g-area', name: 'Area' },
    },
  ];

  function Host({ onSave }: { onSave: (ids: string[]) => void }) {
    const [value, setValue] = useState<string[]>(['l-bug', 'l-s', 'l-web']);
    return (
      <LabelPicker
        labelOptions={LABELS}
        value={value}
        onChange={(ids) => {
          onSave(ids);
          setValue(ids);
        }}
      />
    );
  }

  test('grouped, coloured, and a one-label group swaps its label', async () => {
    const onSave = mock((_ids: string[]) => undefined);
    render(<Host onSave={onSave} />);
    const button = screen.getByRole('button', {
      name: 'Labels: Bug, Small, Web',
    });
    fireEvent.click(button);
    expect(screen.getByRole('group', { name: 'Size' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Area' })).toBeTruthy();
    expect(
      screen
        .getByRole('option', { name: 'Bug' })
        .querySelector('[data-mark="swatch"]')
    ).not.toBeNull();
    await pick('Large');
    expect(onSave).toHaveBeenLastCalledWith(['l-bug', 'l-web', 'l-l']);
    // A multi-select group keeps both.
    await pick('API');
    expect(onSave).toHaveBeenLastCalledWith(['l-bug', 'l-web', 'l-l', 'l-api']);
    // Unticking a one-label group's label just removes it.
    await pick('Large');
    expect(onSave).toHaveBeenLastCalledWith(['l-bug', 'l-web', 'l-api']);
    // The group name is searchable.
    fireEvent.change(combobox(), { target: { value: 'size' } });
    expect(optionNames()).toEqual(['Small', 'Large']);
  });

  test('showColor={false} draws no swatches', () => {
    render(
      <LabelPicker
        labelOptions={LABELS}
        value={['l-bug']}
        showColor={false}
        onChange={() => undefined}
      />
    );
    expect(document.querySelector('[data-mark="swatch"]')).toBeNull();
  });
});

describe('ProjectPicker and MilestonePicker', () => {
  test('status squares, notes, groups and none options', async () => {
    const onProject = mock((_id: string | null) => undefined);
    render(
      <>
        <ProjectPicker
          projects={[
            {
              id: 'p-1',
              name: 'Beacon search',
              hint: 'In progress',
              group: 'Active',
              status: { status: 'at_risk', label: 'At risk' },
            },
            {
              id: 'p-2',
              name: 'Old portal',
              hint: 'Completed',
              group: 'Other',
              disabled: true,
            },
          ]}
          value="p-1"
          onChange={onProject}
        />
        <MilestonePicker
          milestones={[
            { id: 'm-1', name: 'Dual-write', hint: 'Oct 23' },
            { id: 'm-2', name: 'Cutover', hint: 'Nov 6' },
          ]}
          value={null}
          onChange={() => undefined}
        />
      </>
    );
    expect(
      screen.getByRole('button', { name: 'Project: Beacon search' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Milestone: No milestone' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Project/ }));
    expect(
      within(screen.getByRole('listbox')).getByRole('img', { name: 'At risk' })
    ).toBeTruthy();
    expect(
      screen
        .getByRole('option', { name: /Old portal/ })
        .getAttribute('aria-disabled')
    ).toBe('true');
    await pick('No project');
    expect(onProject).toHaveBeenCalledWith(null);
  });
});

describe('EstimatePicker', () => {
  const SCALE = [
    { value: 1, label: '1 point' },
    { value: 2, label: '2 points' },
    { value: 3, label: '3 points' },
  ];

  test('numbers out, null for none, and an off-scale value listed first', async () => {
    const onChange = mock((_value: number | null) => undefined);
    render(<EstimatePicker estimates={SCALE} value={21} onChange={onChange} />);
    const button = screen.getByRole('button', { name: 'Estimate: 21' });
    fireEvent.click(button);
    expect(optionNames()).toEqual([
      'No estimate',
      '21',
      '1 point',
      '2 points',
      '3 points',
    ]);
    await pick('2 points');
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: /^Estimate/ }));
    await pick('No estimate');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('TaskRelationPicker', () => {
  const TASKS: TaskSearchResult[] = [
    {
      id: 'i-12',
      taskKey: 'ENG-12',
      title: 'Index the event stream',
      state: { kind: 'started', label: 'In Progress' },
    },
    { id: 'i-23', taskKey: 'ENG-23', title: 'Typo tolerance' },
    { id: 'i-24', taskKey: 'ENG-24', title: 'Search analytics events' },
  ];

  function fakeSearch() {
    const calls: string[] = [];
    const aborted: string[] = [];
    const search = (query: string, signal: AbortSignal) => {
      calls.push(query);
      signal.addEventListener('abort', () => aborted.push(query));
      const q = query.toLowerCase();
      return Promise.resolve(
        TASKS.filter(
          (task) =>
            task.taskKey.toLowerCase().includes(q) ||
            task.title.toLowerCase().includes(q)
        )
      );
    };
    return { search, calls, aborted };
  }

  const wait = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  test('searches on open and after a pause, excludes, and links the pick', async () => {
    const { search, calls } = fakeSearch();
    const onSelect = mock((_task: TaskSearchResult) => undefined);
    render(
      <TaskRelationPicker
        label="Add blocked by"
        search={search}
        exclude={['i-24']}
        debounceMs={20}
        onSelect={onSelect}
      />
    );
    const button = screen.getByRole('button', { name: 'Add blocked by' });
    expect(button.textContent).toContain('Add');
    fireEvent.click(button);
    await wait(5);
    expect(calls).toEqual(['']);
    expect(optionNames()).toEqual([
      'Index the event streamENG-12',
      'Typo toleranceENG-23',
    ]);
    fireEvent.change(combobox(), { target: { value: 'typo' } });
    // Still the old results until the pause has passed.
    expect(calls).toEqual(['']);
    await wait(40);
    expect(calls).toEqual(['', 'typo']);
    expect(optionNames()).toEqual(['Typo toleranceENG-23']);
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledWith(TASKS[1]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test('a newer search aborts the older one; closing aborts too', async () => {
    const calls: string[] = [];
    const aborted: string[] = [];
    const search = (query: string, signal: AbortSignal) => {
      calls.push(query);
      signal.addEventListener('abort', () => aborted.push(query));
      return new Promise<TaskSearchResult[]>(() => undefined);
    };
    render(
      <TaskRelationPicker
        label="Add blocks"
        search={search}
        debounceMs={0}
        onSelect={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add blocks' }));
    await wait(5);
    expect(
      screen.getByRole('dialog').querySelector('[data-picker-loading]')
    ).not.toBeNull();
    fireEvent.change(combobox(), { target: { value: 'eng' } });
    await wait(5);
    expect(aborted).toEqual(['']);
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    await wait(1);
    expect(aborted).toEqual(['', 'eng']);
  });

  test('a failed search shows the error and Retry runs it again', async () => {
    let fail = true;
    const calls: string[] = [];
    const search = (query: string) => {
      calls.push(query);
      return fail
        ? Promise.reject(new Error('Linear did not answer.'))
        : Promise.resolve(TASKS);
    };
    render(
      <TaskRelationPicker
        label="Add blocks"
        search={search}
        onSelect={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add blocks' }));
    await wait(5);
    expect(screen.getByText('Linear did not answer.')).toBeTruthy();
    fail = false;
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    await wait(5);
    expect(calls).toEqual(['', '']);
    expect(optionNames()).toHaveLength(3);
  });

  test('a rejected link shows the error under the trigger', async () => {
    const { search } = fakeSearch();
    render(
      <TaskRelationPicker
        label="Add blocks"
        search={search}
        onSelect={() => Promise.reject(new Error('That would make a cycle.'))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add blocks' }));
    await wait(5);
    await pick(/Typo tolerance/);
    expect(screen.getByRole('alert').textContent).toContain(
      'That would make a cycle.'
    );
  });

  test('the same task can be linked again after a save settles', async () => {
    const { search } = fakeSearch();
    const onSelect = mock((_task: TaskSearchResult) => undefined);
    render(
      <TaskRelationPicker
        label="Add blocks"
        search={search}
        onSelect={onSelect}
      />
    );
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Add blocks' }));
      await wait(5);
      await pick(/Typo tolerance/);
    }
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  test('minQueryLength holds the search back and says why', async () => {
    const { search, calls } = fakeSearch();
    render(
      <TaskRelationPicker
        label="Add blocks"
        search={search}
        minQueryLength={2}
        hintLabel="Type a key or two letters"
        onSelect={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add blocks' }));
    await wait(5);
    expect(calls).toEqual([]);
    expect(
      screen.getByRole('dialog').querySelector('[data-picker-empty]')
        ?.textContent
    ).toBe('Type a key or two letters');
  });
});
