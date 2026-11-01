import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../../lib/tasksPrefs';
import type { TasksViewMode } from '../../lib/tasksViewMode';
import { DisplayPanel } from './DisplayPanel';

/** A picker's pick saves through a promise; let it settle inside act. */
async function pickOption(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name }));
    await Promise.resolve();
  });
}

interface MountOptions {
  mode?: TasksViewMode;
  prefs?: Partial<TasksDisplayPrefs>;
  showArchived?: boolean;
  archivedCount?: number;
  withModeChange?: boolean;
}

/** A host that owns the prefs and the open state, as IssuesView does, and
    records every prefs write. */
function mount(options: MountOptions = {}) {
  const writes: TasksDisplayPrefs[] = [];
  const archived: boolean[] = [];
  const modes: TasksViewMode[] = [];
  function Host() {
    const [prefs, setPrefs] = useState<TasksDisplayPrefs>({
      ...DEFAULT_TASKS_DISPLAY,
      ...options.prefs,
    });
    const [open, setOpen] = useState(false);
    return (
      <>
        <DisplayPanel
          mode={options.mode ?? 'list'}
          onModeChange={
            options.withModeChange === true
              ? (mode) => {
                  modes.push(mode);
                }
              : undefined
          }
          prefs={prefs}
          onPrefsChange={(next) => {
            writes.push(next);
            setPrefs(next);
          }}
          showArchived={options.showArchived ?? false}
          archivedCount={options.archivedCount ?? 0}
          onShowArchivedChange={(value) => {
            archived.push(value);
          }}
          open={open}
          onOpenChange={setOpen}
        />
        <p>Elsewhere</p>
      </>
    );
  }
  render(<Host />);
  const trigger = () => screen.getByRole('button', { name: 'Display' });
  return {
    writes,
    archived,
    modes,
    trigger,
    last: () => writes[writes.length - 1],
    open: () => {
      fireEvent.click(trigger());
      return screen.getByRole('dialog', { name: 'Display' });
    },
  };
}

describe('DisplayPanel', () => {
  test('the trigger opens a Display dialog with the display-popover slot', () => {
    const { trigger, open } = mount();
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    const panel = open();
    expect(panel.dataset['slot']).toBe('display-popover');
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  test('each picker writes its own prefs key', async () => {
    const { open, last } = mount();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Grouping: Status' }));
    await pickOption('Milestone');
    expect(last()?.grouping).toBe('milestone');

    fireEvent.click(
      screen.getByRole('button', { name: 'Sub-grouping: No grouping' })
    );
    await pickOption('Assignee');
    expect(last()?.subGrouping).toBe('assignee');

    fireEvent.click(screen.getByRole('button', { name: 'Ordering: Priority' }));
    await pickOption('Last updated');
    expect(last()?.ordering).toBe('updated');
    expect(last()?.grouping).toBe('milestone');
  });

  test('the direction button names its action and flips orderDir', () => {
    const { open, last } = mount({ prefs: { orderDir: 'asc' } });
    open();
    const sort = screen.getByRole('button', { name: 'Sort descending' });
    expect(sort.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(sort);
    expect(last()?.orderDir).toBe('desc');
    fireEvent.click(screen.getByRole('button', { name: 'Sort ascending' }));
    expect(last()?.orderDir).toBe('asc');
  });

  test('each switch writes its own prefs key', () => {
    const { open, last } = mount();
    open();
    const cases: [string, keyof TasksDisplayPrefs][] = [
      ['Order completed by recency', 'completedByRecency'],
      ['Show sub-tasks', 'showSubtasks'],
      ['Nested sub-tasks', 'nestedSubtasks'],
      ['Show empty groups', 'showEmptyGroups'],
    ];
    for (const [name, key] of cases) {
      const control = screen.getByRole('switch', { name });
      const before = control.getAttribute('aria-checked') === 'true';
      fireEvent.click(control);
      expect(last()?.[key]).toBe(!before);
      expect(control.getAttribute('aria-checked')).toBe(String(!before));
    }
    const list = screen.getByRole('group', { name: 'List options' });
    expect(within(list).getAllByRole('switch')).toHaveLength(2);
  });

  test('on the board Grouping is pinned to Status with the rest disabled', () => {
    const { open, writes } = mount({
      mode: 'board',
      prefs: { grouping: 'milestone' },
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Grouping: Status' }));
    const status = screen.getByRole('option', { name: 'Status' });
    expect(status.getAttribute('aria-selected')).toBe('true');
    for (const name of ['Epic', 'Milestone', 'Assignee', 'No grouping']) {
      expect(
        screen.getByRole('option', { name }).getAttribute('aria-disabled')
      ).toBe('true');
    }
    fireEvent.click(screen.getByRole('option', { name: 'Epic' }));
    expect(writes).toEqual([]);
  });

  test('letters jump through the Grouping menu, and Enter picks', async () => {
    const { open, last } = mount();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Grouping: Status' }));
    const list = screen.getByRole('listbox', { name: 'Grouping' });
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '')
        ?.textContent;
    fireEvent.keyDown(list, { key: 'm' });
    expect(active()).toBe('Milestone');
    await act(async () => {
      fireEvent.keyDown(list, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(last()?.grouping).toBe('milestone');
    // Only the inner menu closed.
    expect(screen.getByRole('dialog', { name: 'Display' })).toBeTruthy();
  });

  test('Show archived is absent while nothing is archived and it is off', () => {
    mount({ archivedCount: 0 }).open();
    expect(screen.queryByRole('switch', { name: 'Show archived' })).toBeNull();
  });

  test('past the threshold Show archived (N) is named without its count', () => {
    const { open, archived, writes } = mount({ archivedCount: 3 });
    open();
    const control = screen.getByRole('switch', { name: 'Show archived' });
    expect(control.textContent).toContain('Show archived (3)');
    fireEvent.click(control);
    expect(archived).toEqual([true]);
    expect(writes).toEqual([]);
  });

  test('Show archived stays while it is on, even with nothing archived', () => {
    const { open } = mount({ archivedCount: 0, showArchived: true });
    open();
    expect(
      screen
        .getByRole('switch', { name: 'Show archived' })
        .getAttribute('aria-checked')
    ).toBe('true');
  });

  test('a display property toggle flips aria-pressed and the property set', () => {
    const { open, last } = mount();
    open();
    const slot = document.querySelector('[data-slot="display-properties"]');
    expect(slot).not.toBeNull();
    const props = within(slot as HTMLElement);
    const milestone = props.getByRole('button', { name: 'Milestone' });
    expect(milestone.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(milestone);
    expect(last()?.properties.has('milestone')).toBe(true);
    expect(milestone.getAttribute('aria-pressed')).toBe('true');
    const id = props.getByRole('button', { name: 'ID' });
    expect(id.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(id);
    expect(last()?.properties.has('id')).toBe(false);
    expect(id.getAttribute('aria-pressed')).toBe('false');
  });

  test('changing Grouping inside keeps the panel open', async () => {
    const { open } = mount();
    const panel = open();
    fireEvent.click(screen.getByRole('button', { name: 'Grouping: Status' }));
    await pickOption('Epic');
    expect(screen.queryByRole('dialog', { name: 'Grouping' })).toBeNull();
    expect(panel.isConnected).toBe(true);
    expect(screen.getByRole('button', { name: 'Grouping: Epic' })).toBeTruthy();
  });

  test("the inner picker's Escape closes only the picker", () => {
    const { open } = mount();
    const panel = open();
    fireEvent.click(screen.getByRole('button', { name: 'Grouping: Status' }));
    const picker = screen.getByRole('dialog', { name: 'Grouping' });
    fireEvent.keyDown(within(picker).getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Grouping' })).toBeNull();
    expect(panel.isConnected).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Grouping: Status' })
    );
  });

  test('Escape on the panel closes it and returns focus to Display', () => {
    const { open, trigger } = mount();
    const panel = open();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('without onModeChange there is no Layout control', () => {
    mount().open();
    expect(screen.queryByRole('radiogroup', { name: 'Layout' })).toBeNull();
  });

  test('Layout lists the view tabs and switches the mode', () => {
    const { open, modes } = mount({ withModeChange: true, mode: 'list' });
    open();
    const layout = screen.getByRole('radiogroup', { name: 'Layout' });
    const cells = within(layout).getAllByRole('radio');
    expect(cells.map((cell) => cell.textContent)).toEqual(['Board', 'List']);
    fireEvent.click(within(layout).getByRole('radio', { name: 'Board' }));
    expect(modes).toEqual(['board']);
  });
});
