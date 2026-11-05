import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  type PickerOption,
  PickerPopover,
  TaskRelationPicker,
  type TaskSearchResult,
} from '../src/index';

afterEach(cleanup);

// A host-searched picker (filter={false}) shows the last answer while the
// next search runs. Enter pressed in that gap must never write a row of the
// older list: it waits for the answer to the typed text and takes its first
// row. A row the arrow keys reached stays active in a new answer that still
// holds it, so the row Enter picks never depends on when the answer came.

const TASKS: PickerOption[] = [
  { value: 'i-12', label: 'Index the event stream', hint: 'ENG-12' },
  { value: 'i-23', label: 'Typo tolerance', hint: 'ENG-23' },
  { value: 'i-24', label: 'Search analytics events', hint: 'ENG-24' },
];

/** What the host's server answers for a query. */
function answerFor(query: string): PickerOption[] {
  const q = query.trim().toLowerCase();
  return TASKS.filter(
    (task) =>
      task.label.toLowerCase().includes(q) ||
      (task.hint ?? '').toLowerCase().includes(q)
  );
}

/**
 * A host searching on its server: typing keeps the last answer on screen
 * with `loading` set until the test calls `answer()`, which delivers the
 * results for the latest query (as a late network reply would).
 */
function setupSearchHost(onChange: (value: string | null) => void) {
  const control: { answer: () => void } = { answer: () => undefined };
  function SearchHost() {
    const [query, setQuery] = useState('');
    const [shown, setShown] = useState<PickerOption[]>(TASKS);
    const [answered, setAnswered] = useState('');
    control.answer = () => {
      setShown(answerFor(query));
      setAnswered(query);
    };
    return (
      <PickerPopover
        label="Add blocked by"
        options={shown}
        filter={false}
        query={query}
        onQueryChange={setQuery}
        loading={answered !== query}
        value={null}
        action
        onChange={onChange}
      />
    );
  }
  render(<SearchHost />);
  return control;
}

function combobox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox');
}

function activeOption(): HTMLElement | null {
  const id = combobox().getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id);
}

async function press(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(combobox(), { key });
    await Promise.resolve();
  });
}

function type(text: string): void {
  fireEvent.change(combobox(), { target: { value: text } });
}

describe('PickerPopover: Enter before a host search answers', () => {
  test('Enter waits for the answer and picks its first row, never the old list', async () => {
    const onChange = mock((_value: string | null) => undefined);
    const host = setupSearchHost(onChange);
    fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
    type('typo');
    // The unfiltered list is still on screen, with its first row active.
    expect(activeOption()?.textContent).toContain('Index the event stream');
    await press('Enter');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('i-23');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('typing on after Enter drops the waiting pick', async () => {
    const onChange = mock((_value: string | null) => undefined);
    const host = setupSearchHost(onChange);
    fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
    type('typo');
    await press('Enter');
    type('search');
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(activeOption()?.textContent).toContain('Search analytics events');
    // Enter on a list that answers the typed text picks at once.
    await press('Enter');
    expect(onChange).toHaveBeenCalledWith('i-24');
  });

  test('an answer with no rows drops the waiting pick', async () => {
    const onChange = mock((_value: string | null) => undefined);
    const host = setupSearchHost(onChange);
    fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
    type('zzz');
    await press('Enter');
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('a row arrowed to before the answer is picked only if the answer holds it', async () => {
    const onChange = mock((_value: string | null) => undefined);
    const host = setupSearchHost(onChange);
    fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
    type('ENG-2');
    await press('ArrowDown');
    expect(activeOption()?.textContent).toContain('Typo tolerance');
    await press('Enter');
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith('i-23');
  });

  test('a row arrowed to that the answer drops is never picked', async () => {
    const onChange = mock((_value: string | null) => undefined);
    const host = setupSearchHost(onChange);
    fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
    type('typo');
    // Arrow onto the old list's first row, which the answer leaves out.
    await press('ArrowDown');
    await press('ArrowUp');
    expect(activeOption()?.textContent).toContain('Index the event stream');
    await press('Enter');
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(activeOption()?.textContent).toContain('Typo tolerance');
  });

  test('a new answer keeps the arrowed row it still holds, and drops one it lacks', async () => {
    const onChange = mock((_value: string | null) => undefined);
    const host = setupSearchHost(onChange);
    fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
    type('ev');
    // Still the old list (all three): arrow to its third row while the
    // search runs.
    await press('ArrowDown');
    await press('ArrowDown');
    expect(activeOption()?.textContent).toContain('Search analytics events');
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    // "ev" still holds the third row: it stays the active row.
    expect(activeOption()?.textContent).toContain('Search analytics events');
    // An answer without it starts from its own first row. On screen while
    // "typo" runs: the answer to "ev" (ENG-12, ENG-24).
    type('typo');
    await press('ArrowDown');
    expect(activeOption()?.textContent).toContain('Search analytics events');
    await act(async () => {
      host.answer();
      await Promise.resolve();
    });
    expect(activeOption()?.textContent).toContain('Typo tolerance');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Enter just before or just after the answer picks the same arrowed row', async () => {
    for (const enterFirst of [true, false]) {
      const onChange = mock((_value: string | null) => undefined);
      const host = setupSearchHost(onChange);
      fireEvent.click(screen.getByRole('button', { name: /^Add blocked by/ }));
      type('ev');
      await press('ArrowDown');
      await press('ArrowDown');
      if (enterFirst) await press('Enter');
      await act(async () => {
        host.answer();
        await Promise.resolve();
      });
      if (!enterFirst) await press('Enter');
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('i-24');
      cleanup();
    }
  });

  test('a host-filtered multiple menu keeps the arrowed row when its options grow', async () => {
    // FilterPicker's shape: a tick-marked multiple menu over the host's own
    // list (filter={false}, no `loading`), whose options a live update can
    // grow while it is open.
    const onChange = mock((_value: readonly string[]) => undefined);
    const control: { add: () => void } = { add: () => undefined };
    function Host() {
      const [options, setOptions] = useState<PickerOption[]>([
        { value: 'bug', label: 'bug' },
        { value: 'docs', label: 'docs' },
        { value: 'perf', label: 'perf' },
      ]);
      control.add = () =>
        setOptions((list) => [...list, { value: 'ux', label: 'ux' }]);
      return (
        <PickerPopover
          label="Labels"
          multiple
          marks="tick"
          options={options}
          filter={false}
          value={[]}
          onChange={onChange}
        />
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /^Labels/ }));
    await press('ArrowDown');
    await press('ArrowDown');
    expect(activeOption()?.textContent).toContain('perf');
    await act(async () => {
      control.add();
      await Promise.resolve();
    });
    expect(activeOption()?.textContent).toContain('perf');
    await press('Enter');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['perf']);
  });

  test('a pick by pointer drops the waiting Enter of a multiple picker', async () => {
    const onChange = mock((_value: readonly string[]) => undefined);
    const control: { answer: () => void } = { answer: () => undefined };
    const ALL: PickerOption[] = [
      { value: 'a1', label: 'alpha one' },
      { value: 'b1', label: 'beta one' },
      { value: 'c2', label: 'gamma two' },
    ];
    function MultiHost() {
      const [query, setQuery] = useState('');
      const [shown, setShown] = useState<PickerOption[]>(ALL);
      const [answered, setAnswered] = useState('');
      const [value, setValue] = useState<readonly string[]>([]);
      control.answer = () => {
        setShown(ALL.filter((option) => option.label.includes(query)));
        setAnswered(query);
      };
      return (
        <PickerPopover
          label="Labels"
          multiple
          options={shown}
          filter={false}
          query={query}
          onQueryChange={setQuery}
          loading={answered !== query}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<MultiHost />);
    fireEvent.click(screen.getByRole('button', { name: /^Labels/ }));
    type('one');
    await press('Enter');
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /beta one/ }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(['b1']);
    await act(async () => {
      control.answer();
      await Promise.resolve();
    });
    // The answer arrives: the Enter the click settled toggles nothing more.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('a locally filtered list still loading picks at once', async () => {
    const onChange = mock((_value: string | null) => undefined);
    render(
      <PickerPopover
        label="Assignee"
        options={TASKS}
        loading
        value={null}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Assignee/ }));
    type('typo');
    await press('Enter');
    expect(onChange).toHaveBeenCalledWith('i-23');
  });
});

describe('TaskRelationPicker: Enter right after typing', () => {
  const RESULTS: TaskSearchResult[] = [
    { id: 'i-12', taskKey: 'ENG-12', title: 'Index the event stream' },
    { id: 'i-23', taskKey: 'ENG-23', title: 'Typo tolerance' },
    { id: 'i-24', taskKey: 'ENG-24', title: 'Search analytics events' },
  ];

  const wait = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  test('links the first result for the typed text, not the old first row', async () => {
    const search = (query: string) => {
      const q = query.toLowerCase();
      return Promise.resolve(
        RESULTS.filter(
          (task) =>
            task.taskKey.toLowerCase().includes(q) ||
            task.title.toLowerCase().includes(q)
        )
      );
    };
    const onSelect = mock((_task: TaskSearchResult) => undefined);
    render(
      <TaskRelationPicker
        label="Add blocked by"
        search={search}
        debounceMs={20}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add blocked by' }));
    await wait(5);
    type('typo');
    await press('Enter');
    expect(onSelect).not.toHaveBeenCalled();
    await wait(40);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(RESULTS[1]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
