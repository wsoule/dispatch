import { ApiError } from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import {
  EMPTY_TASK_FILTER_SET,
  type TaskFilterSet,
} from '../../lib/taskFilters';
import { FilterMenu, type FilterMenuProps } from './FilterMenu';

const context: FilterMenuProps['context'] = {
  statuses: ['draft', 'ready', 'working', 'review', 'landed'],
  epics: [],
  labels: ['ui'],
  milestones: [],
};

// A popover positions itself a microtask after mount (floating-ui); every open, click and
// keystroke settles inside an async `act` so the assertions see the placed menu.
async function settle(work: () => void | Promise<void>) {
  await act(async () => {
    await work();
    await Promise.resolve();
  });
}

// The way the Tasks header mounts it: controlled open state, filters in state.
function Harness({
  onAiFilter,
  onChange,
  opens,
}: {
  onAiFilter?: FilterMenuProps['onAiFilter'];
  onChange?: (filters: TaskFilterSet) => void;
  opens?: boolean[];
}) {
  const [filters, setFilters] = useState<TaskFilterSet>(EMPTY_TASK_FILTER_SET);
  const [open, setOpen] = useState(false);
  return (
    <FilterMenu
      filters={filters}
      onChange={(next) => {
        setFilters(next);
        onChange?.(next);
      }}
      context={context}
      open={open}
      onOpenChange={(next) => {
        opens?.push(next);
        setOpen(next);
      }}
      onAiFilter={onAiFilter}
    />
  );
}

async function mountOpen(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  await settle(() => {
    fireEvent.click(screen.getByLabelText('Filter'));
  });
  const menu = document.querySelector<HTMLElement>('[data-slot=filter-menu]');
  if (menu === null) throw new Error('the filter menu did not open');
  return menu;
}

async function openAi(menu: HTMLElement) {
  await settle(() => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'AI filter' }));
  });
  return within(menu).getByLabelText<HTMLInputElement>('AI filter');
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

describe('FilterMenu AI filter', () => {
  test('without the prop there is no AI filter row', async () => {
    const menu = await mountOpen();
    expect(
      within(menu).queryByRole('menuitem', { name: 'AI filter' })
    ).toBeNull();
    expect(within(menu).getAllByRole('menuitem')[0]?.textContent).toBe(
      'Status'
    );
  });

  test('with the prop the row comes first, above Status', async () => {
    const menu = await mountOpen({ onAiFilter: async () => URGENT_UNASSIGNED });
    const rows = within(menu).getAllByRole('menuitem');
    expect(rows[0]?.textContent).toBe('AI filter');
    expect(rows[0]?.dataset['facet']).toBe('ai');
    expect(rows[1]?.textContent).toBe('Status');
    // Searching finds it alongside the facets.
    await settle(() => {
      fireEvent.change(screen.getByLabelText('Add filter'), {
        target: { value: 'ai' },
      });
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((row) => row.textContent)
    ).toEqual(['AI filter']);
  });

  test('Enter sends the sentence, applies the result and closes the menu', async () => {
    const sentences: string[] = [];
    const changes: TaskFilterSet[] = [];
    const opens: boolean[] = [];
    const menu = await mountOpen({
      onAiFilter: async (sentence) => {
        sentences.push(sentence);
        return URGENT_UNASSIGNED;
      },
      onChange: (next) => changes.push(next),
      opens,
    });
    const input = await openAi(menu);
    expect(document.activeElement).toBe(input);
    expect(input.placeholder).toBe('Describe a filter…');
    expect(within(menu).getByText('AI filter')).not.toBeNull();
    expect(
      within(menu).getByRole('button', { name: 'Back to filters' })
    ).not.toBeNull();
    await submit(input, ' urgent tasks nobody is on ');
    expect(sentences).toEqual(['urgent tasks nobody is on']);
    expect(changes).toEqual([URGENT_UNASSIGNED]);
    expect(opens.at(-1)).toBe(false);
    expect(document.querySelector('[data-slot=filter-menu]')).toBeNull();
  });

  test('a spinner replaces the keycap while the call is pending', async () => {
    let resolve: (value: TaskFilterSet) => void = () => {};
    const menu = await mountOpen({
      onAiFilter: () =>
        new Promise<TaskFilterSet>((r) => {
          resolve = r;
        }),
    });
    const input = await openAi(menu);
    expect(within(menu).queryByRole('status')).toBeNull();
    await submit(input, 'urgent');
    expect(within(menu).getByRole('status')).not.toBeNull();
    expect(input.disabled).toBe(true);
    await settle(() => {
      resolve(URGENT_UNASSIGNED);
    });
    expect(document.querySelector('[data-slot=filter-menu]')).toBeNull();
  });

  test('a rejecting prop shows its message under the input', async () => {
    const changes: TaskFilterSet[] = [];
    const menu = await mountOpen({
      onAiFilter: () => Promise.reject(new Error('model unavailable')),
      onChange: (next) => changes.push(next),
    });
    const input = await openAi(menu);
    await submit(input, 'urgent');
    expect(within(menu).getByRole('alert').textContent).toBe(
      'model unavailable'
    );
    expect(within(menu).queryByRole('status')).toBeNull();
    expect(changes).toEqual([]);
    // The menu stays open on the subview for another try.
    expect(document.querySelector('[data-slot=filter-menu]')).not.toBeNull();
    expect(input.disabled).toBe(false);
  });

  test('an empty result keeps the subview open instead of clearing the chips', async () => {
    const changes: TaskFilterSet[] = [];
    const opens: boolean[] = [];
    const menu = await mountOpen({
      onAiFilter: async () => EMPTY_TASK_FILTER_SET,
      onChange: (next) => changes.push(next),
      opens,
    });
    const input = await openAi(menu);
    await submit(input, 'something the facets cannot say');
    expect(within(menu).getByRole('alert').textContent).toBe(
      'No filter matched that sentence'
    );
    expect(within(menu).queryByRole('status')).toBeNull();
    expect(changes).toEqual([]);
    expect(opens).not.toContain(false);
    expect(document.querySelector('[data-slot=filter-menu]')).not.toBeNull();
    expect(input.disabled).toBe(false);
  });

  test('a 404 from the daemon reads as the update hint', async () => {
    const menu = await mountOpen({
      onAiFilter: () => Promise.reject(new ApiError('not found', 404)),
    });
    const input = await openAi(menu);
    await submit(input, 'urgent');
    expect(within(menu).getByRole('alert').textContent).toBe(
      'Update the daemon to use AI filters'
    );
  });

  test('a result that lands after the subview closed is ignored', async () => {
    let resolve: (value: TaskFilterSet) => void = () => {};
    const changes: TaskFilterSet[] = [];
    const menu = await mountOpen({
      onAiFilter: () =>
        new Promise<TaskFilterSet>((r) => {
          resolve = r;
        }),
      onChange: (next) => changes.push(next),
    });
    const input = await openAi(menu);
    await submit(input, 'urgent');
    await settle(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    // Escape steps back to the facet list rather than closing the popover.
    expect(document.querySelector('[data-slot=filter-menu]')).not.toBeNull();
    expect(
      within(menu).getByRole('menuitem', { name: 'Status' })
    ).not.toBeNull();
    await settle(() => {
      resolve(URGENT_UNASSIGNED);
    });
    expect(changes).toEqual([]);
    expect(document.querySelector('[data-slot=filter-menu]')).not.toBeNull();
  });

  test('arrow keys still walk the rows with the AI row in front', async () => {
    const menu = await mountOpen({ onAiFilter: async () => URGENT_UNASSIGNED });
    const rows = within(menu).getAllByRole('menuitem');
    rows[0]?.focus();
    fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]?.textContent).toBe('Status');
    fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
  });
});
