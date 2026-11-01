import { ApiError } from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import {
  DAY_MS,
  EMPTY_TASK_FILTER_SET,
  type TaskFilterSet,
} from '../../lib/taskFilters';
import { FilterPicker, type FilterPickerProps } from './FilterPicker';

const context: FilterPickerProps['context'] = {
  statuses: ['draft', 'ready', 'working', 'review', 'landed'],
  milestones: [],
  labels: ['ui'],
};

// Every open, click and keystroke settles inside an async `act`, so the assertions see the
// placed popover and any promise the step resolved.
async function settle(work: () => void | Promise<void>) {
  await act(async () => {
    await work();
    await Promise.resolve();
  });
}

// The way the Issues toolbar mounts it: controlled open state, filters in state.
function Harness({
  onAiFilter,
  onChange,
  opens,
  pickerContext = context,
  initial = EMPTY_TASK_FILTER_SET,
}: {
  onAiFilter?: FilterPickerProps['onAiFilter'];
  onChange?: (filters: TaskFilterSet) => void;
  opens?: boolean[];
  pickerContext?: FilterPickerProps['context'];
  initial?: TaskFilterSet;
}) {
  const [filters, setFilters] = useState<TaskFilterSet>(initial);
  const [open, setOpen] = useState(false);
  return (
    <FilterPicker
      filters={filters}
      onChange={(next) => {
        setFilters(next);
        onChange?.(next);
      }}
      context={pickerContext}
      open={open}
      onOpenChange={(next) => {
        opens?.push(next);
        setOpen(next);
      }}
      onAiFilter={onAiFilter}
    />
  );
}

function filterButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Filter' });
}

function pickerPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot=filter-menu]');
}

function aiPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot=ai-filter]');
}

async function mountOpen(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  await settle(() => {
    fireEvent.click(filterButton());
  });
  const panel = pickerPanel();
  if (panel === null) throw new Error('the filter picker did not open');
  return panel;
}

function optionNames(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByRole('option')
    .map((row) => row.textContent ?? '');
}

function searchBox(panel: HTMLElement): HTMLInputElement {
  return within(panel).getByRole<HTMLInputElement>('combobox');
}

// The option the keyboard would pick: the combobox's active descendant.
function activeOption(panel: HTMLElement): string | null {
  const id = searchBox(panel).getAttribute('aria-activedescendant');
  return id === null
    ? null
    : (document.getElementById(id)?.textContent ?? null);
}

async function choose(panel: HTMLElement, name: string | RegExp) {
  await settle(() => {
    fireEvent.click(within(panel).getByRole('option', { name }));
  });
}

async function openAi(panel: HTMLElement) {
  await choose(panel, 'AI filter');
  const ai = aiPanel();
  if (ai === null) throw new Error('the AI filter did not open');
  return {
    ai,
    input: within(ai).getByLabelText<HTMLInputElement>('AI filter'),
  };
}

async function submit(input: HTMLInputElement, sentence: string) {
  await settle(() => {
    fireEvent.change(input, { target: { value: sentence } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
}

const URGENT_UNASSIGNED: TaskFilterSet = {
  clauses: [
    { facet: 'priority', op: 'is', values: ['urgent'] },
    { facet: 'assignee', op: 'is', values: ['none'] },
  ],
  join: 'and',
};

const FACETS = [
  'Status',
  'Priority',
  'Assignee',
  'Labels',
  'Milestone',
  'Run state',
  'Created',
  'Updated',
];

describe('FilterPicker step one', () => {
  test('the trigger is named Filter and marks an active filter', () => {
    render(<Harness initial={URGENT_UNASSIGNED} />);
    const face = filterButton().querySelector('[data-slot=filter-trigger]');
    expect(face?.getAttribute('data-active')).toBe('true');
  });

  test('without a filter the trigger has no active mark', () => {
    render(<Harness />);
    const face = filterButton().querySelector('[data-slot=filter-trigger]');
    expect(face?.hasAttribute('data-active')).toBe(false);
  });

  test('lists the facets in order in a dialog named Filter facets', async () => {
    const panel = await mountOpen();
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('Filter facets');
    expect(within(panel).getByRole('listbox').getAttribute('aria-label')).toBe(
      'Filter facets'
    );
    expect(searchBox(panel).placeholder).toBe('Add filter…');
    // The search box keeps its own name, apart from the list's.
    expect(searchBox(panel).getAttribute('aria-label')).toBe('Add filter');
    expect(optionNames(panel)).toEqual(FACETS);
    expect(document.activeElement).toBe(searchBox(panel));
  });

  test('the search row teaches the F shortcut, and the trigger declares it', async () => {
    const panel = await mountOpen();
    const keycaps = Array.from(
      searchBox(panel).parentElement?.querySelectorAll('kbd') ?? []
    ).map((kbd) => kbd.textContent);
    expect(keycaps).toContain('F');
    expect(filterButton().getAttribute('aria-keyshortcuts')).toBe('F');
  });

  test('Home and End jump to the first and last row while the search is empty', async () => {
    const panel = await mountOpen({
      onAiFilter: () => Promise.resolve(URGENT_UNASSIGNED),
    });
    const box = searchBox(panel);
    await settle(() => {
      fireEvent.keyDown(box, { key: 'End' });
    });
    expect(activeOption(panel)).toBe('Updated');
    await settle(() => {
      fireEvent.keyDown(box, { key: 'Home' });
    });
    expect(activeOption(panel)).toBe('AI filter');
  });

  test("a facet's hint is its chosen count", async () => {
    const panel = await mountOpen({ initial: URGENT_UNASSIGNED });
    const priority = within(panel).getByRole('option', { name: /^Priority/ });
    expect(priority.textContent).toBe('Priority1');
  });

  test('typing lists matching facets, then values with their facet', async () => {
    const panel = await mountOpen();
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'rev' } });
    });
    expect(optionNames(panel)).toEqual(['Status › Review']);
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'zzz' } });
    });
    expect(within(panel).queryAllByRole('option')).toHaveLength(0);
    expect(panel.querySelector('[data-picker-empty]')?.textContent).toBe(
      'No matching filter'
    );
  });

  test('Enter with a single facet match opens it', async () => {
    const panel = await mountOpen();
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'prior' } });
    });
    await settle(() => {
      fireEvent.keyDown(searchBox(panel), { key: 'Enter' });
    });
    expect(panel.getAttribute('aria-label')).toBe('Priority values');
    expect(searchBox(panel).value).toBe('');
  });

  test('a value found by the search toggles and stays open', async () => {
    const changes: TaskFilterSet[] = [];
    const panel = await mountOpen({ onChange: (next) => changes.push(next) });
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'review' } });
    });
    await choose(panel, 'Status › Review');
    expect(changes).toEqual([
      {
        clauses: [{ facet: 'status', op: 'is', values: ['review'] }],
        join: 'and',
      },
    ]);
    expect(pickerPanel()).not.toBeNull();
    expect(
      within(panel)
        .getByRole('option', { name: 'Status › Review' })
        .getAttribute('aria-selected')
    ).toBe('true');
  });

  test('ArrowDown and ArrowUp walk the facets with the AI row in front', async () => {
    const panel = await mountOpen({
      onAiFilter: () => Promise.resolve(URGENT_UNASSIGNED),
    });
    const box = searchBox(panel);
    expect(activeOption(panel)).toBe('AI filter');
    await settle(() => {
      fireEvent.keyDown(box, { key: 'ArrowDown' });
    });
    expect(activeOption(panel)).toBe('Status');
    await settle(() => {
      fireEvent.keyDown(box, { key: 'ArrowUp' });
    });
    expect(activeOption(panel)).toBe('AI filter');
    // Up from the first row wraps to the last.
    await settle(() => {
      fireEvent.keyDown(box, { key: 'ArrowUp' });
    });
    expect(activeOption(panel)).toBe('Updated');
    await settle(() => {
      fireEvent.keyDown(box, { key: 'ArrowDown' });
    });
    expect(activeOption(panel)).toBe('AI filter');
  });

  test('reopening starts at step one with an empty search', async () => {
    const panel = await mountOpen();
    await choose(panel, 'Status');
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'dra' } });
    });
    await settle(() => {
      fireEvent.click(filterButton());
    });
    expect(pickerPanel()).toBeNull();
    await settle(() => {
      fireEvent.click(filterButton());
    });
    const again = pickerPanel();
    if (again === null) throw new Error('the filter picker did not reopen');
    expect(again.getAttribute('aria-label')).toBe('Filter facets');
    expect(searchBox(again).value).toBe('');
    expect(optionNames(again)).toEqual(FACETS);
  });
});

describe('FilterPicker step two', () => {
  test('Status opens its values behind Back, and Back returns', async () => {
    const panel = await mountOpen();
    await choose(panel, 'Status');
    expect(panel.getAttribute('aria-label')).toBe('Status values');
    expect(within(panel).getByRole('listbox').getAttribute('aria-label')).toBe(
      'Status values'
    );
    expect(optionNames(panel)).toEqual([
      'Back to filters',
      'Draft',
      'Ready',
      'Working',
      'Review',
      'Landed',
    ]);
    // The facet's name titles its values, as the old step's header did.
    const group = within(panel).getByRole('group', { name: 'Status' });
    expect(within(group).getAllByRole('option')).toHaveLength(5);
    expect(document.activeElement).toBe(searchBox(panel));
    await choose(panel, 'Back to filters');
    expect(panel.getAttribute('aria-label')).toBe('Filter facets');
    expect(optionNames(panel)).toEqual(FACETS);
  });

  test('a value toggles into the clause and the picker stays open', async () => {
    const changes: TaskFilterSet[] = [];
    const panel = await mountOpen({ onChange: (next) => changes.push(next) });
    await choose(panel, 'Status');
    await choose(panel, 'Ready');
    await choose(panel, 'Review');
    expect(changes.at(-1)).toEqual({
      clauses: [{ facet: 'status', op: 'is', values: ['ready', 'review'] }],
      join: 'and',
    });
    expect(pickerPanel()).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Status values');
    const ready = within(panel).getByRole('option', { name: 'Ready' });
    expect(ready.getAttribute('aria-selected')).toBe('true');
    expect(
      within(panel).getByRole('listbox').getAttribute('aria-multiselectable')
    ).toBe('true');
    // Toggling it again takes it out.
    await choose(panel, 'Ready');
    expect(changes.at(-1)).toEqual({
      clauses: [{ facet: 'status', op: 'is', values: ['review'] }],
      join: 'and',
    });
  });

  test('typing a value and pressing Enter toggles it (Back steps aside)', async () => {
    const changes: TaskFilterSet[] = [];
    const panel = await mountOpen({ onChange: (next) => changes.push(next) });
    await choose(panel, 'Status');
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'ready' } });
    });
    expect(optionNames(panel)).toEqual(['Ready']);
    expect(activeOption(panel)).toBe('Ready');
    await settle(() => {
      fireEvent.keyDown(searchBox(panel), { key: 'Enter' });
    });
    expect(changes).toEqual([
      {
        clauses: [{ facet: 'status', op: 'is', values: ['ready'] }],
        join: 'and',
      },
    ]);
    expect(panel.getAttribute('aria-label')).toBe('Status values');
    // Clearing the search brings Back again.
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: '' } });
    });
    expect(optionNames(panel)[0]).toBe('Back to filters');
  });

  test('picking the chosen date pick again refreshes its bound to now', async () => {
    const changes: TaskFilterSet[] = [];
    // Picked as "In the last day" some 30 hours ago.
    const stale = new Date(Date.now() - 1.25 * DAY_MS).toISOString();
    const panel = await mountOpen({
      onChange: (next) => changes.push(next),
      initial: {
        clauses: [{ facet: 'created', op: 'after', values: [stale] }],
        join: 'and',
      },
    });
    // Its facet row carries the chosen count.
    await choose(panel, /^Created/);
    const day = within(panel).getByRole('option', { name: 'In the last day' });
    expect(day.getAttribute('aria-selected')).toBe('true');
    await choose(panel, 'In the last day');
    expect(changes).toHaveLength(1);
    const clause = changes[0]?.clauses[0];
    expect(clause?.op).toBe('after');
    const age = (Date.now() - Date.parse(clause?.values[0] ?? '')) / DAY_MS;
    expect(age).toBeGreaterThan(0.99);
    expect(age).toBeLessThan(1.01);
    expect(pickerPanel()).not.toBeNull();
  });

  test('a date pick replaces the previous one', async () => {
    const changes: TaskFilterSet[] = [];
    const panel = await mountOpen({ onChange: (next) => changes.push(next) });
    await choose(panel, 'Created');
    expect(panel.getAttribute('aria-label')).toBe('Created values');
    await choose(panel, 'In the last day');
    await choose(panel, 'In the last week');
    const last = changes.at(-1);
    expect(last?.clauses).toHaveLength(1);
    const clause = last?.clauses[0];
    expect(clause?.facet).toBe('created');
    expect(clause?.op).toBe('after');
    const age = (Date.now() - Date.parse(clause?.values[0] ?? '')) / DAY_MS;
    expect(Math.round(age)).toBe(7);
    expect(
      within(panel)
        .getByRole('option', { name: 'In the last week' })
        .getAttribute('aria-selected')
    ).toBe('true');
    expect(
      within(panel)
        .getByRole('option', { name: 'In the last day' })
        .getAttribute('aria-selected')
    ).toBe('false');
    expect(pickerPanel()).not.toBeNull();
  });

  test('an empty facet says there is nothing to filter on', async () => {
    const panel = await mountOpen({
      pickerContext: { ...context, labels: [] },
    });
    await choose(panel, 'Labels');
    expect(optionNames(panel)).toEqual([
      'Back to filters',
      'Nothing to filter on',
    ]);
    const reason = within(panel).getByRole('option', {
      name: 'Nothing to filter on',
    });
    expect(reason.getAttribute('aria-disabled')).toBe('true');
    await choose(panel, 'Back to filters');
    expect(panel.getAttribute('aria-label')).toBe('Filter facets');
  });

  test('Escape steps back, a second Escape closes and focuses Filter', async () => {
    const opens: boolean[] = [];
    const panel = await mountOpen({ opens });
    await choose(panel, 'Status');
    await settle(() => {
      fireEvent.keyDown(searchBox(panel), { key: 'Escape' });
    });
    expect(pickerPanel()).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Filter facets');
    expect(opens).not.toContain(false);
    await settle(() => {
      fireEvent.keyDown(searchBox(panel), { key: 'Escape' });
    });
    expect(pickerPanel()).toBeNull();
    expect(opens.at(-1)).toBe(false);
    expect(document.activeElement).toBe(filterButton());
  });
});

describe('FilterPicker AI filter', () => {
  test('without the prop there is no AI filter option', async () => {
    const panel = await mountOpen();
    expect(
      within(panel).queryByRole('option', { name: 'AI filter' })
    ).toBeNull();
    expect(optionNames(panel)[0]).toBe('Status');
  });

  test('with the prop the option comes first, above Status', async () => {
    const panel = await mountOpen({
      onAiFilter: () => Promise.resolve(URGENT_UNASSIGNED),
    });
    expect(optionNames(panel).slice(0, 2)).toEqual(['AI filter', 'Status']);
    // Searching finds it too, ahead of any value.
    await settle(() => {
      fireEvent.change(searchBox(panel), { target: { value: 'ai' } });
    });
    expect(optionNames(panel)[0]).toBe('AI filter');
  });

  test('Enter sends the sentence, applies the result and closes', async () => {
    const sentences: string[] = [];
    const changes: TaskFilterSet[] = [];
    const opens: boolean[] = [];
    const panel = await mountOpen({
      onAiFilter: (sentence) => {
        sentences.push(sentence);
        return Promise.resolve(URGENT_UNASSIGNED);
      },
      onChange: (next) => changes.push(next),
      opens,
    });
    const { ai, input } = await openAi(panel);
    // The picker gives way to the AI popover, which takes focus in its input.
    expect(pickerPanel()).toBeNull();
    expect(ai.getAttribute('role')).toBe('dialog');
    expect(ai.getAttribute('aria-label')).toBe('AI filter');
    expect(document.activeElement).toBe(input);
    expect(input.placeholder).toBe('Describe a filter…');
    expect(
      within(ai).getByRole('button', { name: 'Back to filters' })
    ).not.toBeNull();
    await submit(input, ' urgent tasks nobody is on ');
    expect(sentences).toEqual(['urgent tasks nobody is on']);
    expect(changes).toEqual([URGENT_UNASSIGNED]);
    expect(opens.at(-1)).toBe(false);
    expect(aiPanel()).toBeNull();
    expect(pickerPanel()).toBeNull();
  });

  test('a spinner replaces the key cap while the call is pending', async () => {
    let resolve: (value: TaskFilterSet) => void = () => {};
    const panel = await mountOpen({
      onAiFilter: () =>
        new Promise<TaskFilterSet>((r) => {
          resolve = r;
        }),
    });
    const { ai, input } = await openAi(panel);
    expect(within(ai).queryByRole('status')).toBeNull();
    expect(within(ai).getByText('⏎')).not.toBeNull();
    await submit(input, 'urgent');
    expect(within(ai).getByRole('status')).not.toBeNull();
    // Read-only, not disabled: focus stays in the field (and Escape still
    // steps back from it).
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    await settle(() => {
      resolve(URGENT_UNASSIGNED);
    });
    expect(aiPanel()).toBeNull();
  });

  test('a rejecting prop shows its message under the input', async () => {
    const changes: TaskFilterSet[] = [];
    const panel = await mountOpen({
      onAiFilter: () => Promise.reject(new Error('model unavailable')),
      onChange: (next) => changes.push(next),
    });
    const { ai, input } = await openAi(panel);
    await submit(input, 'urgent');
    expect(within(ai).getByRole('alert').textContent).toBe('model unavailable');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(within(ai).queryByRole('status')).toBeNull();
    expect(changes).toEqual([]);
    // The popover stays open for another try, the field still focused.
    expect(aiPanel()).not.toBeNull();
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
    // Typing clears the error.
    await settle(() => {
      fireEvent.change(input, { target: { value: 'urgent ones' } });
    });
    expect(within(ai).queryByRole('alert')).toBeNull();
  });

  test('an empty result keeps the sentence instead of clearing the chips', async () => {
    const changes: TaskFilterSet[] = [];
    const opens: boolean[] = [];
    const panel = await mountOpen({
      onAiFilter: () => Promise.resolve(EMPTY_TASK_FILTER_SET),
      onChange: (next) => changes.push(next),
      opens,
    });
    const { ai, input } = await openAi(panel);
    await submit(input, 'something the facets cannot say');
    expect(within(ai).getByRole('alert').textContent).toBe(
      'No filter matched that sentence'
    );
    expect(within(ai).queryByRole('status')).toBeNull();
    expect(changes).toEqual([]);
    expect(opens).not.toContain(false);
    expect(aiPanel()).not.toBeNull();
    expect(input.value).toBe('something the facets cannot say');
    expect(input.readOnly).toBe(false);
  });

  test('a 404 from the daemon reads as the update hint', async () => {
    const panel = await mountOpen({
      onAiFilter: () => Promise.reject(new ApiError('not found', 404)),
    });
    const { ai, input } = await openAi(panel);
    await submit(input, 'urgent');
    expect(within(ai).getByRole('alert').textContent).toBe(
      'Update the daemon to use AI filters'
    );
  });

  test('a result that lands after the AI filter closed is ignored', async () => {
    let resolve: (value: TaskFilterSet) => void = () => {};
    const changes: TaskFilterSet[] = [];
    const panel = await mountOpen({
      onAiFilter: () =>
        new Promise<TaskFilterSet>((r) => {
          resolve = r;
        }),
      onChange: (next) => changes.push(next),
    });
    const { input } = await openAi(panel);
    await submit(input, 'urgent');
    await settle(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    // Escape steps back to the facets rather than closing the filter.
    expect(aiPanel()).toBeNull();
    const back = pickerPanel();
    if (back === null) throw new Error('Escape closed the filter');
    expect(within(back).getByRole('option', { name: 'Status' })).not.toBeNull();
    await settle(() => {
      resolve(URGENT_UNASSIGNED);
    });
    expect(changes).toEqual([]);
    expect(pickerPanel()).not.toBeNull();
  });

  test('Back to filters returns to step one with an empty search', async () => {
    const panel = await mountOpen({
      onAiFilter: () => Promise.resolve(URGENT_UNASSIGNED),
    });
    const { ai } = await openAi(panel);
    await settle(() => {
      fireEvent.click(
        within(ai).getByRole('button', { name: 'Back to filters' })
      );
    });
    expect(aiPanel()).toBeNull();
    const back = pickerPanel();
    if (back === null) throw new Error('Back closed the filter');
    expect(back.getAttribute('aria-label')).toBe('Filter facets');
    expect(searchBox(back).value).toBe('');
    expect(optionNames(back).slice(0, 2)).toEqual(['AI filter', 'Status']);
  });
});
