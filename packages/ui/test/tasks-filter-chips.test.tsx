// cspell:ignore Projectis Milestoneis Statusisopen -- textContent concatenations asserted below
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import { type FilterChipData, FilterChips } from '../src/index';

afterEach(cleanup);

// FilterChips: Gr8r's chips bar. One chip per set filter ("Project is …"),
// joined by "and", each with a named remove button, an optional editor
// around the face, the host's add control and Clear all.

function chip(
  id: string,
  field: string,
  summary: string,
  extra: Partial<FilterChipData> = {}
): FilterChipData {
  return {
    id,
    field,
    summary,
    onRemove: () => undefined,
    removeLabel: `Remove ${field.toLowerCase()} filter`,
    ...extra,
  };
}

describe('FilterChips', () => {
  test('nothing is drawn without chips', () => {
    const view = render(
      <FilterChips chips={[]} onClearAll={() => undefined} />
    );
    expect(view.container.innerHTML).toBe('');
  });

  test('summaries read "{field} is {summary}", joined by "and"', () => {
    const view = render(
      <FilterChips
        chips={[
          chip('project', 'Project', 'Atlas billing migration, Beacon search'),
          chip('milestone', 'Milestone', '3 milestones'),
          chip('state', 'Status', 'open'),
        ]}
      />
    );
    const bar = view.getByRole('group', { name: 'Filters' });
    const items = within(bar).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'ProjectisAtlas billing migration, Beacon search',
      'andMilestoneis3 milestones',
      'andStatusisopen',
    ]);
  });

  test('× removes its own filter, by name', () => {
    const onRemove = mock(() => {});
    const view = render(
      <FilterChips
        chips={[
          chip('project', 'Project', 'Garnet mobile app'),
          chip('assignee', 'Assignee', 'Me', { onRemove }),
        ]}
      />
    );
    fireEvent.click(
      view.getByRole('button', { name: 'Remove assignee filter' })
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  test('the editor slot wraps the face; an unknown value is marked', () => {
    const opened = mock(() => {});
    const view = render(
      <FilterChips
        chips={[
          chip('milestone', 'Milestone', 'Not found', {
            unknown: true,
            renderEditor: (face) => (
              <button
                type="button"
                aria-label="Milestone filter: Not found"
                onClick={opened}
              >
                {face}
              </button>
            ),
          }),
        ]}
      />
    );
    const trigger = view.getByRole('button', {
      name: 'Milestone filter: Not found',
    });
    expect(trigger.textContent).toBe('MilestoneisNot found');
    fireEvent.click(trigger);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(
      within(trigger).getByText('Not found').getAttribute('data-unknown')
    ).toBe('true');
  });

  test('the add control, and Clear all disabled while filters are the default', () => {
    const onClearAll = mock(() => {});
    const props = {
      chips: [chip('state', 'Status', 'open')],
      add: <button type="button">Filter</button>,
      onClearAll,
    };
    const view = render(<FilterChips {...props} clearDisabled />);
    expect(view.getByRole('button', { name: 'Filter' })).toBeTruthy();
    const clear = view.getByRole('button', {
      name: 'Clear all',
    }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    view.rerender(<FilterChips {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});

describe('FilterChips focus', () => {
  // A host whose chips go when their × is pressed (as navigate() does).
  function Host({ initial }: { initial: FilterChipData[] }) {
    const [chips, setChips] = useState(initial);
    return (
      <FilterChips
        chips={chips.map((c) => ({
          ...c,
          onRemove: () => setChips((all) => all.filter((x) => x.id !== c.id)),
        }))}
        add={<button type="button">Add a filter</button>}
        onClearAll={() =>
          setChips((all) => all.filter((x) => x.id === 'state'))
        }
      />
    );
  }

  const editable = (id: string, field: string, summary: string) =>
    chip(id, field, summary, {
      renderEditor: (face) => (
        <button type="button" aria-label={`${field} filter: ${summary}`}>
          {face}
        </button>
      ),
    });

  test('a removed chip hands focus to the next chip, else the previous one', () => {
    const view = render(
      <Host
        initial={[
          editable('project', 'Project', 'Atlas'),
          editable('priority', 'Priority', 'High'),
          chip('blocked', 'Blocked', 'yes'),
          editable('team', 'Team', 'Platform'),
        ]}
      />
    );
    const press = (name: string) => {
      const button = view.getByRole('button', { name });
      act(() => button.focus());
      fireEvent.click(button);
    };
    // The next chip's face (its picker).
    press('Remove project filter');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Priority filter: High'
    );
    // A quick chip has no face to focus: its ×.
    press('Remove priority filter');
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Remove blocked filter' })
    );
    // The last chip: the previous one.
    press('Remove team filter');
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Remove blocked filter' })
    );
  });

  test('Clear all hands focus to + Filter', () => {
    const view = render(
      <Host
        initial={[
          editable('project', 'Project', 'Atlas'),
          editable('state', 'Status', 'open'),
        ]}
      />
    );
    const clear = view.getByRole('button', { name: 'Clear all' });
    act(() => clear.focus());
    fireEvent.click(clear);
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Add a filter' })
    );
    expect(
      view.queryByRole('button', { name: 'Remove project filter' })
    ).toBeNull();
  });
});
