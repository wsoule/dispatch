import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { type SavedViewsApi, useSavedViews } from '../../hooks/useSavedViews';
import type { SavedView } from '../../lib/savedViews';
import {
  EMPTY_TASK_FILTER_SET,
  type TaskFilterSet,
} from '../../lib/taskFilters';
import { DEFAULT_TASKS_DISPLAY } from '../../lib/tasksPrefs';
import { TASKS_PRESETS, type TasksPreset } from '../../lib/tasksPresets';
import { SavedViewsMenu } from './SavedViewsMenu';

const ROOT = '/tmp/saved-views-menu-test';
const VIEWS_KEY = `dispatch:saved-views:${ROOT}`;
const FAVORITES_KEY = `dispatch:favorites:${ROOT}`;
const DONE_FILTERS: TaskFilterSet = {
  join: 'and',
  clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
};

afterEach(() => {
  window.localStorage.clear();
});

/** Seeds the stored views (and which are starred) the hook loads on mount. */
function seed(views: { id: string; name: string }[], starred: string[] = []) {
  const stored: SavedView[] = views.map((view) => ({
    ...view,
    filters: EMPTY_TASK_FILTER_SET,
    display: DEFAULT_TASKS_DISPLAY,
    createdAt: '2026-09-20T00:00:00.000Z',
  }));
  window.localStorage.setItem(
    VIEWS_KEY,
    JSON.stringify(
      stored.map((view) => ({
        ...view,
        display: { layout: view.display.layout },
      }))
    )
  );
  window.localStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify(starred.map((id) => ({ kind: 'view', id })))
  );
}

interface Calls {
  presets: TasksPreset[];
  selected: string[];
  saved: { name: string; favorite: boolean; filters: TaskFilterSet }[];
  updated: { id: string; filters: TaskFilterSet }[];
  renamed: [string, string][];
  deleted: string[];
  starred: string[];
  closed: number;
}

/**
 * Mounts the menu over the real saved-views hook (localStorage), every
 * mutation recorded on its way through. `active` selects a stored view
 * first; `filters` is what the page shows (a view saved with no filters
 * then reads as edited).
 */
function mount(
  options: {
    preset?: TasksPreset;
    active?: string;
    filters?: TaskFilterSet;
    withViews?: boolean;
  } = {}
) {
  const calls: Calls = {
    presets: [],
    selected: [],
    saved: [],
    updated: [],
    renamed: [],
    deleted: [],
    starred: [],
    closed: 0,
  };
  let api: SavedViewsApi | null = null;
  function Host() {
    const real = useSavedViews(ROOT);
    api = real;
    const [preset, setPreset] = useState<TasksPreset>(options.preset ?? 'all');
    const recorded: SavedViewsApi = {
      ...real,
      selectView: (id) => {
        calls.selected.push(id);
        real.selectView(id);
      },
      saveView: (input) => {
        calls.saved.push({
          name: input.name,
          favorite: input.favorite,
          filters: input.filters,
        });
        return real.saveView(input);
      },
      updateView: (id, patch) => {
        calls.updated.push({ id, filters: patch.filters });
        real.updateView(id, patch);
      },
      renameView: (id, name) => {
        calls.renamed.push([id, name]);
        real.renameView(id, name);
      },
      deleteView: (id) => {
        calls.deleted.push(id);
        real.deleteView(id);
      },
      toggleFavorite: (ref) => {
        calls.starred.push(ref.id);
        real.toggleFavorite(ref);
      },
      clearActiveView: () => {
        calls.closed += 1;
        real.clearActiveView();
      },
    };
    return (
      <>
        <SavedViewsMenu
          preset={preset}
          onPreset={(next) => {
            calls.presets.push(next);
            setPreset(next);
          }}
          savedViews={options.withViews === false ? null : recorded}
          filters={options.filters ?? EMPTY_TASK_FILTER_SET}
          display={DEFAULT_TASKS_DISPLAY}
        />
        <p>Elsewhere</p>
      </>
    );
  }
  render(<Host />);
  if (options.active !== undefined) {
    const id = options.active;
    act(() => api?.selectView(id));
  }
  const face = () => screen.getByTestId('tasks-preset');
  const trigger = () =>
    screen.getByRole('button', { name: face().textContent ?? '' });
  return {
    calls,
    api: () => api,
    face,
    trigger,
    openMenu: () => {
      fireEvent.click(face());
      return screen.getByRole('dialog', { name: 'View' });
    },
  };
}

/** A listbox group's name: the heading its aria-labelledby points at. */
function groupName(group: HTMLElement): string | null {
  const id = group.getAttribute('aria-labelledby');
  return id === null
    ? null
    : (document.getElementById(id)?.textContent ?? null);
}

/** Picks a menu option; the pick runs through the picker's save promise. */
async function pick(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name }));
    await Promise.resolve();
  });
}

/** Opens the menu and picks Save view… (or Rename…): the name form. */
async function openForm(
  menu: ReturnType<typeof mount>,
  action: 'Save view…' | 'Rename…' = 'Save view…'
) {
  menu.openMenu();
  await pick(action);
  const name = action === 'Rename…' ? 'Rename view' : 'Save view';
  const dialog = screen.getByRole('dialog', { name });
  return {
    dialog,
    name: () => within(dialog).getByLabelText<HTMLInputElement>('View name'),
    save: () => within(dialog).getByRole('button', { name: 'Save' }),
    favorite: () => within(dialog).queryByRole('switch', { name: 'Favorite' }),
  };
}

describe('SavedViewsMenu trigger', () => {
  test('reads view: and the preset, and a click opens the menu', () => {
    const menu = mount({ preset: 'mine' });
    expect(menu.face().textContent).toBe('view: Mine');
    expect(menu.trigger().getAttribute('aria-haspopup')).toBe('dialog');
    menu.openMenu();
    expect(menu.trigger().getAttribute('aria-expanded')).toBe('true');
  });

  test('an open view reads its name, the preset unless All, and edited once it drifts', () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const clean = mount({ active: 'v-1' });
    expect(clean.face().textContent).toBe('view: Done work');
    clean.openMenu();
    expect(screen.queryByRole('option', { name: /^Update/ })).toBeNull();
  });

  test('a drifted view with a preset reads all three parts', () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const menu = mount({
      active: 'v-1',
      preset: 'mine',
      filters: DONE_FILTERS,
    });
    expect(menu.face().textContent).toBe('view: Done work · Mine · edited');
  });
});

describe('SavedViewsMenu list', () => {
  test('presets, then starred views, then saved views, then the actions', () => {
    seed(
      [
        { id: 'v-1', name: 'Starred one' },
        { id: 'v-2', name: 'Plain one' },
      ],
      ['v-1']
    );
    const menu = mount();
    const popup = menu.openMenu();
    const names = within(popup)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual([
      ...TASKS_PRESETS.map((p) => p.label),
      'Starred one',
      'Starred one',
      'Plain one',
      'Save view…',
    ]);
    const groups = within(popup).getAllByRole('group');
    expect(groups.map((group) => groupName(group))).toEqual([
      'Show',
      'Starred views',
      'Saved views',
      'Actions',
    ]);
    expect(
      within(within(popup).getByRole('group', { name: 'Starred views' }))
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Starred one']);
  });

  test('the preset and the open view are selected, nothing else is', () => {
    seed(
      [
        { id: 'v-1', name: 'First' },
        { id: 'v-2', name: 'Second' },
      ],
      []
    );
    const menu = mount({ preset: 'mine', active: 'v-2' });
    const popup = menu.openMenu();
    const selected = within(popup)
      .getAllByRole('option')
      .filter((option) => option.getAttribute('aria-selected') === 'true')
      .map((option) => option.textContent);
    expect(selected).toEqual(['Mine', 'Second']);
  });

  test('letters jump through the menu (typeahead)', () => {
    seed([{ id: 'v-1', name: 'Zebra crossing' }]);
    const menu = mount();
    const popup = menu.openMenu();
    const list = within(popup).getByRole('listbox');
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '')
        ?.textContent;
    fireEvent.keyDown(list, { key: 'r' });
    expect(active()).toBe('Review');
    // The same letter again walks on to the next row starting with it.
    fireEvent.keyDown(list, { key: 'r' });
    expect(active()).toBe('Ready');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(active()).toBe('All');
  });

  test('typeahead reaches a saved view', () => {
    seed([{ id: 'v-1', name: 'Zebra crossing' }]);
    const menu = mount();
    const popup = menu.openMenu();
    const list = within(popup).getByRole('listbox');
    fireEvent.keyDown(list, { key: 'z' });
    expect(
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '')
        ?.textContent
    ).toBe('Zebra crossing');
  });

  test('picking a preset calls onPreset and closes with focus on the trigger', async () => {
    const menu = mount();
    menu.openMenu();
    await pick('Needs you');
    expect(menu.calls.presets).toEqual(['needs-you']);
    expect(screen.queryByRole('dialog', { name: 'View' })).toBeNull();
    expect(menu.face().textContent).toBe('view: Needs you');
    expect(document.activeElement).toBe(menu.trigger());
  });

  test('a starred or a saved view selects it', async () => {
    seed([{ id: 'v-1', name: 'Starred one' }], ['v-1']);
    const menu = mount();
    menu.openMenu();
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('option', { name: 'Starred one' })[0]
      );
      await Promise.resolve();
    });
    expect(menu.calls.selected).toEqual(['v-1']);
    expect(menu.api()?.activeViewId).toBe('v-1');
  });

  test('without the saved-views provider only the presets show', () => {
    const menu = mount({ withViews: false });
    const popup = menu.openMenu();
    expect(within(popup).getAllByRole('option')).toHaveLength(
      TASKS_PRESETS.length
    );
    expect(
      within(popup).queryByRole('option', { name: 'Save view…' })
    ).toBeNull();
  });
});

describe('SavedViewsMenu actions on the open view', () => {
  test('Update shows only when the view drifted, and writes the page back', async () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const menu = mount({ active: 'v-1', filters: DONE_FILTERS });
    menu.openMenu();
    const actions = screen
      .getAllByRole('option')
      .map((option) => option.textContent)
      .slice(-6);
    expect(actions).toEqual([
      'Save view…',
      'Update “Done work”',
      'Rename…',
      'Star view',
      'Delete view',
      'Close view',
    ]);
    await pick('Update “Done work”');
    expect(menu.calls.updated).toEqual([{ id: 'v-1', filters: DONE_FILTERS }]);
  });

  test('Star view stars the open view; then it reads Remove star', async () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const menu = mount({ active: 'v-1' });
    menu.openMenu();
    await pick('Star view');
    expect(menu.calls.starred).toEqual(['v-1']);
    menu.openMenu();
    expect(screen.getByRole('option', { name: 'Remove star' })).toBeTruthy();
    expect(screen.getAllByRole('option', { name: 'Done work' })).toHaveLength(
      2
    );
  });

  test('Close view clears the open view', async () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const menu = mount({ active: 'v-1' });
    menu.openMenu();
    await pick('Close view');
    expect(menu.calls.closed).toBe(1);
    expect(menu.face().textContent).toBe('view: All');
  });

  test('Delete asks first: Cancel has focus and Enter does not confirm', async () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const menu = mount({ active: 'v-1' });
    menu.openMenu();
    await pick('Delete view');
    const dialog = screen.getByRole('alertdialog', { name: 'Delete view?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Cancel' })
    );
    const confirm = within(dialog).getByRole('button', { name: 'Delete view' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Enter' });
    expect(menu.calls.deleted).toEqual([]);
    fireEvent.click(confirm);
    expect(menu.calls.deleted).toEqual(['v-1']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(menu.face().textContent).toBe('view: All');
  });

  test('Cancel on the delete question keeps the view', async () => {
    seed([{ id: 'v-1', name: 'Done work' }]);
    const menu = mount({ active: 'v-1' });
    menu.openMenu();
    await pick('Delete view');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(menu.calls.deleted).toEqual([]);
    expect(menu.api()?.views).toHaveLength(1);
  });
});

// The name form (ported from SaveViewDialog.test.tsx).
describe('SavedViewsMenu name form', () => {
  test('submit reports the trimmed name and the favourite switch', async () => {
    const menu = mount();
    const form = await openForm(menu);
    expect(document.activeElement).toBe(form.name());
    expect(form.save().hasAttribute('disabled')).toBe(true);
    fireEvent.change(form.name(), { target: { value: '  Urgent bugs ' } });
    expect(form.save().hasAttribute('disabled')).toBe(false);
    const favorite = form.favorite();
    expect(favorite).not.toBeNull();
    if (favorite !== null) fireEvent.click(favorite);
    expect(form.favorite()?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(form.save());
    expect(menu.calls.saved).toEqual([
      { name: 'Urgent bugs', favorite: true, filters: EMPTY_TASK_FILTER_SET },
    ]);
    const created = menu.api()?.views[0];
    expect(menu.calls.selected).toEqual([created?.id ?? '']);
    expect(menu.face().textContent).toBe('view: Urgent bugs');
    expect(form.dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(menu.trigger());
  });

  test('a blank name disables Save and ⌘⏎ does nothing', async () => {
    const menu = mount();
    const form = await openForm(menu);
    fireEvent.change(form.name(), { target: { value: '   ' } });
    expect(form.save().hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(form.name(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(form.name(), { key: 'Enter' });
    expect(menu.calls.saved).toEqual([]);
    expect(form.dialog.isConnected).toBe(true);
  });

  test('⌘⏎ and Enter in the field submit', async () => {
    const menu = mount();
    let form = await openForm(menu);
    fireEvent.change(form.name(), { target: { value: 'Mine' } });
    fireEvent.keyDown(form.name(), { key: 'Enter', metaKey: true });
    expect(menu.calls.saved.map((s) => s.name)).toEqual(['Mine']);
    form = await openForm(menu);
    fireEvent.change(form.name(), { target: { value: 'Theirs' } });
    fireEvent.keyDown(form.name(), { key: 'Enter' });
    expect(menu.calls.saved.map((s) => s.name)).toEqual(['Mine', 'Theirs']);
    form = await openForm(menu);
    fireEvent.change(form.name(), { target: { value: 'Ctrl' } });
    // Ctrl+Enter anywhere in the form, the switch included; a plain Enter
    // there is the switch's own.
    const favorite = form.favorite();
    expect(favorite).not.toBeNull();
    if (favorite !== null) {
      fireEvent.keyDown(favorite, { key: 'Enter' });
      expect(menu.calls.saved).toHaveLength(2);
      fireEvent.keyDown(favorite, { key: 'Enter', ctrlKey: true });
    }
    expect(menu.calls.saved).toHaveLength(3);
  });

  test('rename hides the switch, prefills and never reports a favourite', async () => {
    seed([{ id: 'v-1', name: 'Old name' }]);
    const menu = mount({ active: 'v-1' });
    const form = await openForm(menu, 'Rename…');
    expect(form.favorite()).toBeNull();
    expect(form.name().value).toBe('Old name');
    expect(form.save().hasAttribute('disabled')).toBe(false);
    fireEvent.change(form.name(), { target: { value: ' New name ' } });
    fireEvent.click(form.save());
    expect(menu.calls.renamed).toEqual([['v-1', 'New name']]);
    expect(menu.calls.saved).toEqual([]);
    expect(menu.face().textContent).toBe('view: New name');
  });

  test('Cancel closes without submitting, and a reopen starts empty', async () => {
    const menu = mount();
    let form = await openForm(menu);
    fireEvent.change(form.name(), { target: { value: 'Draft' } });
    fireEvent.click(
      within(form.dialog).getByRole('button', { name: 'Cancel' })
    );
    expect(menu.calls.saved).toEqual([]);
    expect(form.dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(menu.trigger());
    form = await openForm(menu);
    expect(form.name().value).toBe('');
  });

  test('Escape closes the form and returns focus to the trigger', async () => {
    const menu = mount();
    const form = await openForm(menu);
    fireEvent.keyDown(form.name(), { key: 'Escape' });
    expect(form.dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(menu.trigger());
  });

  test('Shift+Tab out of the name field lands on the trigger', async () => {
    const menu = mount();
    const form = await openForm(menu);
    expect(document.activeElement).toBe(form.name());
    fireEvent.keyDown(form.name(), { key: 'Tab', shiftKey: true });
    expect(form.dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(menu.trigger());
  });

  test('Tab past Save leaves from the trigger', async () => {
    const menu = mount();
    const form = await openForm(menu);
    fireEvent.change(form.name(), { target: { value: 'Mine' } });
    const save = form.save();
    act(() => save.focus());
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(form.dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(menu.trigger());
  });

  test('the name field says what the form does', async () => {
    const menu = mount();
    const form = await openForm(menu);
    expect(form.name().getAttribute('aria-describedby')).not.toBeNull();
    const described = screen.getByRole('textbox', {
      name: 'View name',
      description: 'Name the current filters and display as a view.',
    });
    expect(described === form.name()).toBe(true);
  });

  test('opening the menu again closes the form', async () => {
    const menu = mount();
    const form = await openForm(menu);
    await act(async () => {
      fireEvent.click(menu.face());
      await Promise.resolve();
    });
    expect(form.dialog.isConnected).toBe(false);
    expect(screen.getByRole('dialog', { name: 'View' })).toBeTruthy();
  });
});
