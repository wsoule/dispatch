import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import {
  AssigneePicker,
  Dialog,
  type LabelChoice,
  LabelPicker,
  PickerMarkView,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  type SaveResult,
  StatePicker,
  TaskSlideOver,
} from '../src/index';

afterEach(cleanup);

// PickerPopover: open/close and focus, the combobox + listbox semantics,
// filtering, the keyboard, single and multiple choice, and the save
// contract (pending, kept, rolled back with the error inline).

const PEOPLE: PickerOption[] = [
  { value: 'ana', label: 'Ana Moreno', mark: { kind: 'avatar', name: 'Ana' } },
  { value: 'ben', label: 'Ben Okafor', hint: 'ben' },
  { value: 'jose', label: 'José Álvarez' },
  { value: 'gone', label: 'Gone Person', disabled: true },
  { value: 'dev', label: 'Dev Patel', group: 'Platform' },
];

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A host that owns the value and updates it when the save resolves. */
function Host({
  initial = 'ana',
  save,
  noneLabel,
}: {
  initial?: string | null;
  save?: (next: string | null) => SaveResult;
  noneLabel?: string;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <PickerPopover
      label="Assignee"
      options={PEOPLE}
      value={value}
      noneLabel={noneLabel}
      placeholder="Unassigned"
      onChange={async (next) => {
        await save?.(next);
        setValue(next);
      }}
    />
  );
}

function trigger(name: RegExp | string = /^Assignee/): HTMLElement {
  return screen.getByRole('button', { name });
}

function combobox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox');
}

function activeOption(): HTMLElement | null {
  const id = combobox().getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id);
}

function optionNames(): string[] {
  return within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((el) => el.textContent ?? '');
}

describe('PickerPopover: opening and semantics', () => {
  test('the trigger names the property and its value, and says it opens a dialog', () => {
    render(<Host />);
    const button = trigger();
    expect(button.getAttribute('aria-label')).toBe('Assignee: Ana Moreno');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a click opens a dialog with a combobox that controls the listbox', () => {
    render(<Host />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog', { name: 'Assignee' });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(dialog.id);
    const input = combobox();
    expect(document.activeElement).toBe(input);
    const list = screen.getByRole('listbox', { name: 'Assignee' });
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(dialog.getAttribute('popover')).toBe('manual');
  });

  test('the current value starts active and is the selected option', () => {
    render(<Host initial="ben" />);
    fireEvent.click(trigger());
    expect(activeOption()?.textContent).toContain('Ben Okafor');
    const selected = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .filter((el) => el.getAttribute('aria-selected') === 'true');
    expect(selected.map((el) => el.textContent)).toEqual(['Ben Okaforben']);
  });

  test('groups are labelled groups inside the listbox', () => {
    render(<Host />);
    fireEvent.click(trigger());
    const group = screen.getByRole('group', { name: 'Platform' });
    expect(within(group).getByRole('option').textContent).toContain(
      'Dev Patel'
    );
  });

  test('a disabled option is listed, marked and skipped by the arrows', () => {
    render(<Host initial="jose" />);
    fireEvent.click(trigger());
    const gone = screen.getByRole('option', { name: /Gone Person/ });
    expect(gone.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toContain('Dev Patel');
  });

  test('ArrowDown on the trigger opens it too', () => {
    render(<Host />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('disabled: no popover', () => {
    render(
      <PickerPopover
        label="Assignee"
        options={PEOPLE}
        value="ana"
        disabled
        onChange={() => undefined}
      />
    );
    fireEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PickerPopover: filtering and the keyboard', () => {
  test('typing filters by label, hint and folded accents', () => {
    render(<Host />);
    fireEvent.click(trigger());
    fireEvent.change(combobox(), { target: { value: 'jose' } });
    expect(optionNames()).toEqual(['José Álvarez']);
    fireEvent.change(combobox(), { target: { value: 'BEN' } });
    expect(optionNames()).toEqual(['Ben Okaforben']);
    // The first match becomes active.
    expect(activeOption()?.textContent).toContain('Ben Okafor');
  });

  test('no match says so and leaves nothing active', () => {
    render(<Host />);
    fireEvent.click(trigger());
    fireEvent.change(combobox(), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(
      screen.getByRole('dialog').querySelector('[data-picker-empty]')
        ?.textContent
    ).toBe('No match');
    expect(combobox().getAttribute('aria-activedescendant')).toBeNull();
    expect(
      within(screen.getByRole('dialog')).getByRole('status').textContent
    ).toBe('No match');
  });

  test('↑/↓ move the active option and wrap', () => {
    render(<Host initial="ana" />);
    fireEvent.click(trigger());
    const input = combobox();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toContain('Ben Okafor');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption()?.textContent).toContain('Dev Patel');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toContain('Ana Moreno');
  });

  test('Enter picks the active option, closes and returns focus', async () => {
    const save = mock(() => undefined);
    render(<Host save={save} />);
    fireEvent.click(trigger());
    fireEvent.change(combobox(), { target: { value: 'dev' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith('dev');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Dev Patel');
  });

  test('a click picks too', async () => {
    const save = mock(() => undefined);
    render(<Host save={save} />);
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /José/ }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith('jose');
  });

  test('picking the current value again saves nothing', () => {
    const save = mock(() => undefined);
    render(<Host save={save} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
  });

  test('Esc closes without saving, returns focus and is not seen by the page', () => {
    const save = mock(() => undefined);
    const pageEsc = mock((_event: KeyboardEvent) => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEsc(event);
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<Host save={save} />);
      fireEvent.click(trigger());
      fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
      fireEvent.keyDown(combobox(), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger());
      expect(save).not.toHaveBeenCalled();
      expect(pageEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  // A host's single-key shortcut opened it from elsewhere (a row's title):
  // Esc and a choice go back there; Tab still leaves from the trigger.
  test('returnFocus takes focus on Esc and on a choice, not on Tab', () => {
    function KeyHost() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <a href="#row" data-testid="title">
            Row title
          </a>
          <PickerPopover
            label="Assignee"
            options={PEOPLE}
            value="ana"
            open={open}
            onOpenChange={setOpen}
            returnFocus={() => screen.getByTestId('title')}
            onChange={() => undefined}
          />
          <button type="button" onClick={() => setOpen(true)}>
            Open by key
          </button>
        </>
      );
    }
    render(<KeyHost />);
    const title = screen.getByTestId('title');
    const openIt = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Open by key' }));
    openIt();
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(title);
    openIt();
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(title);
    openIt();
    fireEvent.keyDown(combobox(), { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test('Tab closes and leaves from the trigger', () => {
    render(<Host />);
    fireEvent.click(trigger());
    fireEvent.keyDown(combobox(), { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test('a pointer down outside closes it', () => {
    render(
      <>
        <Host />
        <p>Elsewhere</p>
      </>
    );
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a pointer down inside keeps it open', () => {
    render(<Host />);
    fireEvent.click(trigger());
    fireEvent.pointerDown(combobox());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('the none option clears the value', async () => {
    const save = mock(() => undefined);
    render(<Host save={save} noneLabel="Unassigned" />);
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Unassigned' }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith(null);
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Unassigned');
  });

  test('the none option is filtered like the rest', () => {
    render(<Host noneLabel="Unassigned" />);
    fireEvent.click(trigger());
    fireEvent.change(combobox(), { target: { value: 'ana' } });
    expect(screen.queryByRole('option', { name: 'Unassigned' })).toBeNull();
  });

  test('controlled open follows the host', () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Shortcut
          </button>
          <PickerPopover
            label="Assignee"
            options={PEOPLE}
            value="ana"
            open={open}
            onOpenChange={setOpen}
            onChange={() => undefined}
          />
        </>
      );
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(combobox());
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PickerPopover: multiple', () => {
  const LABELS: PickerOption[] = [
    { value: 'bug', label: 'Bug', mark: { kind: 'swatch', color: '#eb5757' } },
    { value: 'ux', label: 'UX', mark: { kind: 'swatch', color: 'red' } },
    { value: 'perf', label: 'Performance' },
  ];

  function Multi({ save }: { save: (next: string[]) => SaveResult }) {
    const [value, setValue] = useState<string[]>(['bug']);
    return (
      <PickerPopover
        multiple
        label="Labels"
        placeholder="Add label"
        noneLabel="No labels"
        options={LABELS}
        value={value}
        onChange={async (next) => {
          await save(next);
          setValue(next);
        }}
      />
    );
  }

  test('Enter toggles and the popover stays open', async () => {
    const save = mock((_next: string[]) => undefined);
    render(<Multi save={save} />);
    fireEvent.click(trigger(/^Labels/));
    expect(
      screen.getByRole('listbox').getAttribute('aria-multiselectable')
    ).toBe('true');
    fireEvent.change(combobox(), { target: { value: 'perf' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(save).toHaveBeenLastCalledWith(['bug', 'perf']);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(
      screen
        .getByRole('option', { name: /Performance/ })
        .getAttribute('aria-selected')
    ).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Performance/ }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenLastCalledWith(['bug']);
    expect(trigger(/^Labels/).getAttribute('aria-label')).toBe('Labels: Bug');
  });

  test('the none option clears every value', async () => {
    const save = mock((_next: string[]) => undefined);
    render(<Multi save={save} />);
    fireEvent.click(trigger(/^Labels/));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'No labels' }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenLastCalledWith([]);
    expect(trigger(/^Labels/).getAttribute('aria-label')).toBe(
      'Labels: Add label'
    );
  });

  test('only hex colours are painted as swatches', () => {
    render(<Multi save={() => undefined} />);
    fireEvent.click(trigger(/^Labels/));
    const swatches = screen
      .getByRole('dialog')
      .querySelectorAll<HTMLElement>('[data-mark="swatch"]');
    expect(swatches).toHaveLength(2);
    expect(swatches[0].style.backgroundColor).not.toBe('');
    expect(swatches[1].getAttribute('data-empty')).toBe('true');
    expect(swatches[1].getAttribute('style')).toBeNull();
  });
});

describe('PickerPopover: the save contract', () => {
  test('pending shows the new value, a rejection rolls back with the error inline', async () => {
    const pending = deferred();
    render(<Host save={() => pending.promise} />);
    fireEvent.click(trigger());
    fireEvent.change(combobox(), { target: { value: 'ben' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });

    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Ben Okafor');
    expect(trigger().getAttribute('data-pending')).toBe('true');
    expect(screen.getByText('Saving')).toBeTruthy();
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe(
      'Saving Assignee'
    );

    await act(async () => {
      pending.reject(new Error('Linear refused the change.'));
      await pending.promise.catch(() => undefined);
    });

    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Ana Moreno');
    expect(trigger().getAttribute('data-pending')).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    expect(alert.textContent).toContain('Linear refused the change.');
    expect(trigger().getAttribute('aria-describedby')).toBe(alert.id);
  });

  test('the error moves into the open popover and clears on the next save', async () => {
    let fail = true;
    render(
      <Host
        save={() => (fail ? Promise.reject(new Error('Nope.')) : undefined)}
      />
    );
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('Nope.');
    fireEvent.click(trigger());
    expect(
      within(screen.getByRole('dialog')).getByRole('alert').textContent
    ).toContain('Nope.');
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /José/ }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: José Álvarez');
  });

  test('a resolved save keeps the new value until the host catches up', async () => {
    // The host only learns the new value later (a server refresh).
    function LateHost() {
      const [value, setValue] = useState<string | null>('ana');
      return (
        <>
          <button type="button" onClick={() => setValue('ben')}>
            Refresh
          </button>
          <PickerPopover
            label="Assignee"
            options={PEOPLE}
            value={value}
            onChange={() => Promise.resolve()}
          />
        </>
      );
    }
    render(<LateHost />);
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
      await Promise.resolve();
    });
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Ben Okafor');
    expect(trigger().getAttribute('data-pending')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Ben Okafor');
  });

  test('the host value wins once it moves', async () => {
    function MovingHost() {
      const [value, setValue] = useState<string | null>('ana');
      return (
        <>
          <button type="button" onClick={() => setValue('dev')}>
            Someone else
          </button>
          <PickerPopover
            label="Assignee"
            options={PEOPLE}
            value={value}
            onChange={() => new Promise<void>(() => undefined)}
          />
        </>
      );
    }
    render(<MovingHost />);
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
      await Promise.resolve();
    });
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Ben Okafor');
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }));
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Dev Patel');
  });

  test('only the latest save counts', async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    render(<Host save={() => queue.shift()?.promise} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /José/ }));
    await act(async () => {
      second.resolve();
      await second.promise;
    });
    await act(async () => {
      first.reject(new Error('Stale failure.'));
      await first.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: José Álvarez');
  });

  test('a synchronous throw is a rejection', async () => {
    render(
      <PickerPopover
        label="Assignee"
        options={PEOPLE}
        value="ana"
        onChange={() => {
          throw new Error('Boom.');
        }}
      />
    );
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('Boom.');
    expect(trigger().getAttribute('aria-label')).toBe('Assignee: Ana Moreno');
  });

  test('formatError words the message', async () => {
    render(
      <PickerPopover
        label="Assignee"
        options={PEOPLE}
        value="ana"
        formatError={() => 'Linear is down.'}
        onChange={() => Promise.reject(new Error('503'))}
      />
    );
    fireEvent.click(trigger());
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('Linear is down.');
  });
});

describe('PickerPopover: loading and errors in the list', () => {
  test('loading shows a row and marks the list busy', () => {
    render(
      <PickerPopover
        label="Assignee"
        options={[]}
        value={null}
        loading
        onChange={() => undefined}
      />
    );
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('true');
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('[data-picker-loading]')?.textContent).toBe(
      'Loading'
    );
    expect(dialog.querySelector('[data-picker-empty]')).toBeNull();
  });

  test('an options error prints, and Retry is an option Enter can pick', () => {
    const onRetry = mock(() => undefined);
    render(
      <PickerPopover
        label="Assignee"
        options={[]}
        value={null}
        error="Linear did not answer."
        onRetry={onRetry}
        onChange={() => undefined}
      />
    );
    fireEvent.click(trigger());
    expect(screen.getByText('Linear did not answer.')).toBeTruthy();
    expect(activeOption()?.textContent).toBe('Retry');
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('a value missing from the options prints valueLabel', () => {
    render(
      <PickerPopover
        label="Assignee"
        options={PEOPLE}
        value="old"
        valueLabel="Old Person (deactivated)"
        onChange={() => undefined}
      />
    );
    expect(trigger().getAttribute('aria-label')).toBe(
      'Assignee: Old Person (deactivated)'
    );
  });
});

describe('PickerPopover inside the task drawer', () => {
  test('Esc closes the picker, not the drawer, and a second Esc closes the drawer', () => {
    const onClose = mock(() => undefined);
    render(
      <TaskSlideOver
        open
        onClose={onClose}
        taskKey="ENG-24"
        title="Search analytics events"
        status={{ kind: 'unstarted', label: 'Todo' }}
        properties={[
          {
            label: 'Assignee',
            value: (
              <PickerPopover
                label="Assignee"
                options={PEOPLE}
                value="ana"
                onChange={() => undefined}
              />
            ),
          },
        ]}
      />
    );
    fireEvent.click(trigger());
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Assignee' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('PickerPopover as a menu (searchable={false})', () => {
  const ITEMS: PickerOption[] = [
    { value: 'open', label: 'Open', hint: '↵' },
    { value: 'move', label: 'Move to milestone…', hint: 'M' },
    { value: 'chain', label: 'Blocking chain', disabled: true },
    { value: 'copy', label: 'Copy link' },
  ];

  function Menu({ onPick }: { onPick: (value: string | null) => void }) {
    return (
      <PickerPopover
        label="Actions for ENG-12"
        options={ITEMS}
        value={null}
        action
        searchable={false}
        trigger="…"
        triggerLabel="Actions for ENG-12"
        onChange={onPick}
      />
    );
  }

  test('no search row: the list takes focus and drives the active option', () => {
    render(<Menu onPick={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for ENG-12' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    const list = screen.getByRole('listbox', { name: 'Actions for ENG-12' });
    expect(document.activeElement).toBe(list);
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '');
    expect(active()?.textContent).toContain('Open');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(active()?.textContent).toContain('Move to milestone…');
    // The disabled item is skipped.
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(active()?.textContent).toContain('Copy link');
  });

  test('Enter and Space pick; Esc closes and returns focus to the trigger', async () => {
    const picks: (string | null)[] = [];
    render(<Menu onPick={(value) => picks.push(value)} />);
    const button = screen.getByRole('button', { name: 'Actions for ENG-12' });
    fireEvent.click(button);
    let list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    // A pick saves through the action's (resolved) promise: let it settle.
    await act(async () => {
      fireEvent.keyDown(list, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(picks).toEqual(['move']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    list = screen.getByRole('listbox');
    await act(async () => {
      fireEvent.keyDown(list, { key: ' ' });
      await Promise.resolve();
    });
    expect(picks).toEqual(['move', 'open']);
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test('a phone sheet keeps a Done button without the search row', () => {
    render(<Menu onPick={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for ENG-12' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Home and End jump to the first and last option (disabled skipped)', () => {
    render(<Menu onPick={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for ENG-12' }));
    const list = screen.getByRole('listbox');
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '');
    fireEvent.keyDown(list, { key: 'End' });
    expect(active()?.textContent).toBe('Copy link');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(active()?.textContent).toContain('Open');
  });

  test('action mode: a selected option is the current one, picks still run', async () => {
    const picks: (string | null)[] = [];
    render(
      <PickerPopover
        label="View"
        options={[
          { value: 'all', label: 'All', selected: true },
          { value: 'mine', label: 'Mine' },
          { value: 'save', label: 'Save view…' },
        ]}
        value={null}
        action
        searchable={false}
        onChange={(value) => {
          picks.push(value);
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const all = screen.getByRole('option', { name: 'All' });
    expect(all.getAttribute('aria-selected')).toBe('true');
    expect(all.querySelector('svg')).not.toBeNull();
    expect(
      screen.getByRole('option', { name: 'Mine' }).getAttribute('aria-selected')
    ).toBe('false');
    // The current option is where the list starts.
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-activedescendant')).toBe(all.id);
    await act(async () => {
      fireEvent.click(all);
      await Promise.resolve();
    });
    expect(picks).toEqual(['all']);
  });

  test('a search box keeps Home and End for its caret while it holds text', () => {
    render(<Host />);
    fireEvent.click(trigger());
    const box = combobox();
    fireEvent.change(box, { target: { value: 'o' } });
    const before = box.getAttribute('aria-activedescendant');
    const notPrevented = fireEvent.keyDown(box, { key: 'End' });
    // Not prevented, and the active option did not move.
    expect(notPrevented).toBe(true);
    expect(box.getAttribute('aria-activedescendant')).toBe(before);
  });

  test('an empty search box hands Home and End to the list', () => {
    render(<Host />);
    fireEvent.click(trigger());
    const box = combobox();
    expect(fireEvent.keyDown(box, { key: 'End' })).toBe(false);
    expect(activeOption()?.textContent).toContain('Dev Patel');
    expect(fireEvent.keyDown(box, { key: 'Home' })).toBe(false);
    expect(activeOption()?.textContent).toContain('Ana Moreno');
  });

  test('typeahead: letters jump to the next option starting with them', () => {
    const NAMES: PickerOption[] = [
      { value: 'all', label: 'All' },
      { value: 'mine', label: 'Mine' },
      { value: 'needs', label: 'Needs you' },
      { value: 'my-open', label: 'My open' },
    ];
    render(
      <PickerPopover
        label="View"
        options={NAMES}
        value={null}
        action
        searchable={false}
        onChange={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const list = screen.getByRole('listbox');
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '');
    expect(fireEvent.keyDown(list, { key: 'm' })).toBe(false);
    expect(active()?.textContent).toBe('Mine');
    // The same letter again walks on to the next match.
    fireEvent.keyDown(list, { key: 'm' });
    expect(active()?.textContent).toBe('My open');
    // A modified key is never typeahead.
    expect(fireEvent.keyDown(list, { key: 'n', metaKey: true })).toBe(true);
    expect(active()?.textContent).toBe('My open');
  });

  test('typeahead: a word typed together narrows past a first-letter match', async () => {
    const NAMES: PickerOption[] = [
      { value: 'mine', label: 'Mine' },
      { value: 'milestone', label: 'Milestone' },
    ];
    render(
      <PickerPopover
        label="Grouping"
        options={NAMES}
        value="mine"
        searchable={false}
        onChange={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Grouping/ }));
    const list = screen.getByRole('listbox');
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '');
    fireEvent.keyDown(list, { key: 'm' });
    fireEvent.keyDown(list, { key: 'i' });
    fireEvent.keyDown(list, { key: 'l' });
    expect(active()?.textContent).toBe('Milestone');
    // After a pause the search starts over.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
    fireEvent.keyDown(list, { key: 'm' });
    expect(active()?.textContent).toBe('Mine');
  });

  test('an option with an href is followed, never chosen or saved', () => {
    const picks: (string | null)[] = [];
    const assign = mock((_href: string) => undefined);
    const original = window.location.assign;
    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: assign,
    });
    try {
      render(
        <PickerPopover
          label="Workspace"
          searchable={false}
          value="a"
          options={[
            { value: 'a', label: 'Acme' },
            {
              value: 'more',
              label: 'Connect another workspace',
              href: '/setup/connect',
              group: 'Connect',
              groupTitleHidden: true,
            },
          ]}
          onChange={(value) => {
            picks.push(value);
          }}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
      const link = screen.getByRole('option', {
        name: 'Connect another workspace',
      });
      expect(link.getAttribute('aria-selected')).toBe('false');
      // The group shows only its divider; its title still names it.
      const group = screen.getByRole('group');
      const title = document.getElementById(
        group.getAttribute('aria-labelledby') ?? ''
      );
      expect(title?.textContent).toBe('Connect');
      expect(title?.parentElement?.className).toContain('srOnly');
      fireEvent.click(link);
      expect(assign.mock.calls).toEqual([['/setup/connect']]);
      expect(picks).toEqual([]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.querySelector('[data-edit-pending]')).toBeNull();
    } finally {
      Object.defineProperty(window.location, 'assign', {
        configurable: true,
        value: original,
      });
    }
  });
});

// onSelect is an action in place ("Add project…"): it closes the popover,
// hands focus back to the trigger, then runs once; never a value.
describe('PickerPopover in-place actions (PickerOption.onSelect)', () => {
  /** Records where focus was each time the action ran. */
  function actionRow(
    focusAt: (Element | null)[],
    extra: Partial<PickerOption> = {}
  ): PickerOption {
    return {
      value: 'add',
      label: 'Add project…',
      group: 'Add',
      groupTitleHidden: true,
      onSelect: () => {
        focusAt.push(document.activeElement);
      },
      ...extra,
    };
  }

  function savingWords(): (string | null)[] {
    return screen
      .getAllByRole('status')
      .map((region) => region.textContent)
      .filter((text) => text?.includes('Saving') === true);
  }

  test('a click closes, returns focus to the trigger, then runs it once', () => {
    const focusAt: (Element | null)[] = [];
    const picks: (string | null)[] = [];
    render(
      <PickerPopover
        label="Project"
        searchable={false}
        value="a"
        options={[{ value: 'a', label: 'Atlas' }, actionRow(focusAt)]}
        onChange={(value) => {
          picks.push(value);
        }}
      />
    );
    const button = trigger(/^Project/);
    fireEvent.click(button);
    const row = screen.getByRole('option', { name: 'Add project…' });
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect(row.querySelector('svg.lucide-check')).toBeNull();
    fireEvent.click(row);
    expect(focusAt).toEqual([button]);
    expect(picks).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('[data-edit-pending]')).toBeNull();
    expect(button.getAttribute('data-pending')).toBeNull();
    expect(savingWords()).toEqual([]);
  });

  test('Enter in a search box runs it once, and the popover is gone by then', () => {
    // Whether the popover was still in the document each time it ran.
    const openWhenRun: boolean[] = [];
    const picks: (string | null)[] = [];
    const run = mock(() => {
      openWhenRun.push(screen.queryByRole('dialog') !== null);
    });
    render(
      <PickerPopover
        label="Project"
        value="a"
        options={[
          { value: 'a', label: 'Atlas' },
          { value: 'add', label: 'Add project…', onSelect: run },
        ]}
        onChange={(value) => {
          picks.push(value);
        }}
      />
    );
    fireEvent.click(trigger(/^Project/));
    fireEvent.change(combobox(), { target: { value: 'add' } });
    expect(activeOption()?.textContent).toBe('Add project…');
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(openWhenRun).toEqual([false]);
    expect(picks).toEqual([]);
    expect(document.activeElement).toBe(trigger(/^Project/));
  });

  test('Space in a menu runs it once', () => {
    const run = mock(() => undefined);
    render(
      <PickerPopover
        label="Project"
        searchable={false}
        value={null}
        options={[
          { value: 'a', label: 'Atlas' },
          { value: 'add', label: 'Add project…', onSelect: run },
        ]}
        onChange={() => undefined}
      />
    );
    fireEvent.click(trigger(/^Project/));
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: ' ' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('never chosen, even when its value is the value', () => {
    const focusAt: (Element | null)[] = [];
    render(
      <PickerPopover
        label="Project"
        searchable={false}
        value="add"
        options={[{ value: 'a', label: 'Atlas' }, actionRow(focusAt)]}
        onChange={() => undefined}
      />
    );
    fireEvent.click(trigger(/^Project/));
    const row = screen.getByRole('option', { name: 'Add project…' });
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect(row.querySelector('svg.lucide-check')).toBeNull();
    // Not the automatic active row either: the list starts at the top.
    const list = screen.getByRole('listbox');
    expect(
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '')
        ?.textContent
    ).toBe('Atlas');
  });

  test('multiple and action modes run it without touching the value', async () => {
    const multiFocus: (Element | null)[] = [];
    const multiPicks: string[][] = [];
    const { unmount } = render(
      <PickerPopover
        label="Labels"
        multiple
        value={['a']}
        options={[{ value: 'a', label: 'Atlas' }, actionRow(multiFocus)]}
        onChange={(values) => {
          multiPicks.push(values);
        }}
      />
    );
    fireEvent.click(trigger(/^Labels/));
    const multiRow = screen.getByRole('option', { name: 'Add project…' });
    expect(multiRow.getAttribute('aria-selected')).toBe('false');
    // No checkbox square to tick: an action is not a value.
    expect(multiRow.querySelector('svg[viewBox="0 0 12 12"]')).toBeNull();
    expect(
      screen
        .getByRole('option', { name: 'Atlas' })
        .querySelector('svg[viewBox="0 0 12 12"]')
    ).not.toBeNull();
    fireEvent.click(multiRow);
    expect(multiFocus).toEqual([trigger(/^Labels/)]);
    expect(multiPicks).toEqual([]);
    // Unlike a toggle, an action closes a multiple picker.
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    const actionFocus: (Element | null)[] = [];
    const actionPicks: (string | null)[] = [];
    render(
      <PickerPopover
        label="Actions"
        action
        searchable={false}
        value={null}
        options={[
          { value: 'open', label: 'Open' },
          actionRow(actionFocus, { selected: true }),
        ]}
        onChange={(value) => {
          actionPicks.push(value);
        }}
      />
    );
    fireEvent.click(trigger(/^Actions/));
    const actionRowEl = screen.getByRole('option', { name: 'Add project…' });
    // `selected` marks an action menu's current row; an in-place action
    // is never one.
    expect(actionRowEl.getAttribute('aria-selected')).toBe('false');
    await act(async () => {
      fireEvent.click(actionRowEl);
      await Promise.resolve();
    });
    expect(actionFocus).toEqual([trigger(/^Actions/)]);
    expect(actionPicks).toEqual([]);
    expect(savingWords()).toEqual([]);
  });

  test('href wins when a row sets both', () => {
    const run = mock(() => undefined);
    const assign = mock((_href: string) => undefined);
    const original = window.location.assign;
    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: assign,
    });
    try {
      render(
        <PickerPopover
          label="Project"
          searchable={false}
          value={null}
          options={[
            {
              value: 'add',
              label: 'Add project…',
              href: '/setup',
              onSelect: run,
            },
          ]}
          onChange={() => undefined}
        />
      );
      fireEvent.click(trigger(/^Project/));
      fireEvent.click(screen.getByRole('option', { name: 'Add project…' }));
      expect(assign.mock.calls).toEqual([['/setup']]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.location, 'assign', {
        configurable: true,
        value: original,
      });
    }
  });

  test('returnFocus takes focus before the action runs', () => {
    const focusAt: (Element | null)[] = [];
    render(
      <>
        <button type="button" data-testid="title">
          Title
        </button>
        <PickerPopover
          label="Project"
          searchable={false}
          value={null}
          returnFocus={() => screen.getByTestId('title')}
          options={[actionRow(focusAt)]}
          onChange={() => undefined}
        />
      </>
    );
    fireEvent.click(trigger(/^Project/));
    fireEvent.click(screen.getByRole('option', { name: 'Add project…' }));
    expect(focusAt).toEqual([screen.getByTestId('title')]);
  });

  test('a Dialog it opens takes the trigger as its opener and hands focus back', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <PickerPopover
            label="Project"
            searchable={false}
            value="a"
            options={[
              { value: 'a', label: 'Atlas' },
              {
                value: 'add',
                label: 'Add project…',
                onSelect: () => setOpen(true),
              },
            ]}
            onChange={() => undefined}
          />
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Add a project"
          >
            <input aria-label="Folder" />
          </Dialog>
        </>
      );
    }
    render(<Host />);
    const button = trigger(/^Project/);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('option', { name: 'Add project…' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a project' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Only the host's dialog: the picker's popover is gone.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('PickerPopover review additions', () => {
  test("marks='tick': a one-choice-per-group menu draws trailing ticks, no squares", () => {
    render(
      <PickerPopover
        label="Sort"
        multiple
        marks="tick"
        searchable={false}
        value={['sort:weight']}
        options={[
          { value: 'sort:weight', label: 'Weight', group: 'Sort by' },
          { value: 'sort:priority', label: 'Priority', group: 'Sort by' },
          {
            value: 'dir:asc',
            label: 'Ascending',
            group: 'Order',
            disabled: true,
          },
        ]}
        onChange={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    const list = screen.getByRole('listbox', { name: 'Sort' });
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    const weight = screen.getByRole('option', { name: /Weight/ });
    expect(weight.getAttribute('aria-selected')).toBe('true');
    // No checkbox squares on any row, chosen, open or disabled.
    expect(list.querySelectorAll('[data-checked]')).toHaveLength(0);
    expect(
      Array.from(list.querySelectorAll('[role="option"]')).map(
        (option) => option.querySelector('svg.lucide-check') !== null
      )
    ).toEqual([true, false, false]);
  });

  test('anchorPoint opens the popover at that point, not under the trigger', () => {
    render(
      <PickerPopover
        label="Actions for ENG-12"
        options={[{ value: 'open', label: 'Open' }]}
        value={null}
        action
        searchable={false}
        open
        anchorPoint={{ x: 300, y: 200 }}
        trigger="…"
        triggerLabel="Actions for ENG-12"
        onChange={() => undefined}
      />
    );
    const layer = screen.getByRole('dialog').closest('[popover]');
    if (!(layer instanceof HTMLElement)) throw new Error('no popover layer');
    expect(layer.dataset.side).toBe('below');
    expect(layer.style.getPropertyValue('--picker-left')).toBe('300px');
    expect(layer.style.getPropertyValue('--picker-top')).toBe('204px');
  });

  test('a disabled row (a note, a reason) wraps instead of being cut', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'edit',
        'picker-popover.module.css'
      ),
      'utf8'
    );
    expect(css).toMatch(/\.disabled \.optionLabel \{\s*white-space: normal;/);
  });

  test('forced colours keep the card an edge once its shadow is gone', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'edit',
        'picker-popover.module.css'
      ),
      'utf8'
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{[^@]*\.panel \{\s*border: 1px solid CanvasText;/
    );
  });
});

describe('PickerPopover appearances for lists', () => {
  test('cell and bar draw the trigger in their own voice', () => {
    render(
      <>
        <PickerPopover
          label="Status"
          options={[{ value: 's1', label: 'In Progress' }]}
          value="s1"
          appearance="cell"
          onChange={() => undefined}
        />
        <PickerPopover
          label="Priority"
          options={[{ value: '1', label: 'Urgent' }]}
          value={null}
          action
          appearance="bar"
          trigger="Priority"
          triggerLabel="Set priority for 3 issues"
          onChange={() => undefined}
        />
      </>
    );
    const cell = screen.getByRole('button', { name: 'Status: In Progress' });
    expect(cell.getAttribute('data-appearance')).toBe('cell');
    const bar = screen.getByRole('button', {
      name: 'Set priority for 3 issues',
    });
    expect(bar.getAttribute('data-appearance')).toBe('bar');
    expect(bar.textContent).toBe('Priority');
  });

  test('the stylesheet defines both', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'edit',
        'picker-popover.module.css'
      ),
      'utf8'
    );
    expect(css).toMatch(/^\.cell \{/m);
    expect(css).toMatch(/^\.bar \{/m);
    // brand: the shell's brand row (the workspace switcher), full width.
    expect(css).toMatch(/^\.brand \{[^}]*flex: 1 1 auto;/m);
    // The bulk bar is Gr8r's inverted pill: its actions are ghost buttons
    // in --text-inv at 0.85 opacity (4.5:1 on the fill: tasks-contrast),
    // in the sentence-case sans, with a faint light wash on hover (never
    // the accent flood).
    const bar = /^\.bar \{[^}]*\}/m.exec(css)?.[0] ?? '';
    expect(bar).toContain('color: var(--text-inv);');
    expect(bar).toContain('opacity: 0.85;');
    expect(bar).not.toContain('font-family: var(--font-mono);');
    expect(css).toMatch(
      /\.bar:not\(:disabled\):hover \{\s*background: color-mix\(in srgb, var\(--text-inv\) 14%, transparent\);\s*opacity: 1;/
    );
    // A cell trigger takes the cell's voice instead of its own.
    const cell = /^\.cell \{[^}]*\}/m.exec(css)?.[0] ?? '';
    expect(cell).toContain('font: inherit;');
  });
});

// appearance="mark": a glyph-only trigger (a board card's properties). It
// prints no words, so its name carries the value; it opens itself on Enter
// and Space and keeps those keys from the card around it.
describe('PickerPopover appearance="mark"', () => {
  const STATES = [
    { id: 's-todo', name: 'Todo', kind: 'unstarted' as const },
    { id: 's-doing', name: 'In Progress', kind: 'started' as const },
  ];

  test('draws the chosen mark and no text, named "Label: Value"', () => {
    render(
      <StatePicker
        states={STATES}
        value="s-doing"
        appearance="mark"
        onChange={() => undefined}
      />
    );
    const button = screen.getByRole('button', { name: 'Status: In Progress' });
    expect(button.getAttribute('data-appearance')).toBe('mark');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg[data-kind="started"]')).not.toBeNull();
  });

  test('triggerLabel names it; a trigger face replaces the mark', () => {
    render(
      <>
        <PriorityPicker
          value={2}
          appearance="mark"
          triggerLabel="Priority of ENG-12: High"
          onChange={() => undefined}
        />
        <PickerPopover
          label="Labels"
          multiple
          options={[{ value: 'bug', label: 'Bug' }]}
          value={[]}
          appearance="mark"
          trigger={<span data-testid="host-face" />}
          onChange={() => undefined}
        />
      </>
    );
    const priority = screen.getByRole('button', {
      name: 'Priority of ENG-12: High',
    });
    expect(priority.textContent).toBe('');
    expect(priority.querySelector('svg[data-priority="2"]')).not.toBeNull();
    const labels = screen.getByRole('button', { name: /^Labels/ });
    expect(labels.querySelector('[data-testid="host-face"]')).not.toBeNull();
  });

  test('nobody is the none mark; several values draw their marks side by side', () => {
    render(
      <>
        <AssigneePicker
          people={[{ id: 'ana', name: 'Ana Moreno' }]}
          value={null}
          appearance="mark"
          onChange={() => undefined}
        />
        <LabelPicker
          labelOptions={[
            { id: 'bug', name: 'Bug', color: '#e5484d' },
            { id: 'ui', name: 'UI', color: '#4ea7fc' },
          ]}
          value={['bug', 'ui']}
          appearance="mark"
          onChange={() => undefined}
        />
      </>
    );
    const assignee = screen.getByRole('button', {
      name: 'Assignee: Unassigned',
    });
    expect(assignee.textContent).toBe('');
    expect(
      assignee.querySelector('[data-mark="avatar"]')?.getAttribute('data-empty')
    ).toBe('true');
    const labels = screen.getByRole('button', { name: 'Labels: Bug, UI' });
    expect(labels.textContent).toBe('');
    expect(labels.querySelectorAll('[data-mark="swatch"]').length).toBe(2);
  });

  test('with nothing to draw it shows the empty ring, still named', () => {
    render(
      <PickerPopover
        label="Estimate"
        options={[{ value: '1', label: '1 point' }]}
        value={null}
        placeholder="No estimate"
        appearance="mark"
        onChange={() => undefined}
      />
    );
    const button = screen.getByRole('button', {
      name: 'Estimate: No estimate',
    });
    expect(button.textContent).toBe('');
    expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  test('opens on a click, and Escape returns focus to it', () => {
    render(
      <StatePicker
        states={STATES}
        value="s-todo"
        appearance="mark"
        onChange={() => undefined}
      />
    );
    const button = screen.getByRole('button', { name: 'Status: Todo' });
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Status' })).toBeTruthy();
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test('at rest it is the root and its button alone; the live region mounts on first open', () => {
    render(
      <StatePicker
        states={STATES}
        value="s-todo"
        appearance="mark"
        onChange={() => undefined}
      />
    );
    const button = screen.getByRole('button', { name: 'Status: Todo' });
    const root = button.parentElement;
    // No row around a glyph-only trigger, and no "Saving" region until used:
    // a board pays for these per card.
    expect(root?.hasAttribute('data-picker')).toBe(true);
    expect(root?.children).toHaveLength(1);
    expect(screen.queryAllByRole('status', { hidden: true })).toHaveLength(0);
    fireEvent.click(button);
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    // Once opened it stays, so a save that outlives the popover is spoken.
    const region = Array.from(root?.children ?? []).find(
      (el) => el.getAttribute('role') === 'status'
    );
    expect(region).toBeDefined();
    expect(region?.textContent).toBe('');
  });

  test('Enter and Space open it and never reach the card around it', () => {
    const cardKeys = mock((_key: string) => undefined);
    render(
      // A board card picks itself up on Space (a keyboard drag) and opens
      // on Enter; a picker inside it must keep both keys.
      <div onKeyDown={(event) => cardKeys(event.key)}>
        <StatePicker
          states={STATES}
          value="s-todo"
          appearance="mark"
          onChange={() => undefined}
        />
      </div>
    );
    const button = screen.getByRole('button', { name: 'Status: Todo' });
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        button.dispatchEvent(event);
      });
      // The default is prevented, so the button's own click does not
      // toggle it shut again.
      expect([key, event.defaultPrevented]).toEqual([key, true]);
      expect([key, screen.queryByRole('dialog') !== null]).toEqual([key, true]);
      fireEvent.keyDown(combobox(), { key: 'Escape' });
      expect(document.activeElement).toBe(button);
    }
    expect(cardKeys).not.toHaveBeenCalled();
  });

  test('another appearance leaves Enter and Space to the button', () => {
    const cardKeys = mock((_key: string) => undefined);
    render(
      <div onKeyDown={(event) => cardKeys(event.key)}>
        <StatePicker
          states={STATES}
          value="s-todo"
          onChange={() => undefined}
        />
      </div>
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Status: Todo' }), {
      key: 'Enter',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cardKeys).toHaveBeenCalledWith('Enter');
  });

  test('a pending save dims the face and prints no words beside it', async () => {
    const save = deferred();
    render(
      <StatePicker
        states={STATES}
        value="s-todo"
        appearance="mark"
        onChange={() => save.promise}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Status: Todo' }));
    fireEvent.click(screen.getByRole('option', { name: /In Progress/ }));
    const button = screen.getByRole('button', { name: 'Status: In Progress' });
    expect(button.getAttribute('data-pending')).toBe('true');
    expect(
      button.parentElement?.querySelector('[data-edit-pending]')
    ).toBeNull();
    await act(async () => {
      save.resolve();
      await save.promise;
    });
  });

  test('the module draws a 24px target, the fill, the ring and a forced-colours edge', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'edit',
        'picker-popover.module.css'
      ),
      'utf8'
    ).replace(/\s+/g, ' ');
    expect(css).toContain(
      '.mark { justify-content: center; min-width: 24px; min-height: 24px;'
    );
    expect(css).toContain('inset: 2px;');
    expect(css).toContain(
      ".mark[aria-expanded='true']::before { background: var(--surface-3); }"
    );
    expect(css).toContain(
      '.mark:not(:disabled):hover::before { background: var(--surface-3); }'
    );
    expect(css).toContain(
      '.mark:focus-visible { outline: 2px solid var(--focus-ring);'
    );
    expect(css).toContain('.mark::before { border-color: ButtonText; }');
  });
});

describe('PickerMarkView avatar', () => {
  test('initials in the round avatar; nobody is the same circle, dashed and empty', () => {
    const { container } = render(
      <>
        <PickerMarkView mark={{ kind: 'avatar', name: 'Ana Moreno' }} />
        <PickerMarkView mark={{ kind: 'avatar', name: '' }} />
        <PickerMarkView mark={{ kind: 'avatar', name: '  ' }} />
      </>
    );
    const marks = [...container.querySelectorAll('[data-mark="avatar"]')];
    expect(marks.map((m) => m.textContent)).toEqual(['AM', '', '']);
    expect(marks.map((m) => m.getAttribute('data-empty'))).toEqual([
      null,
      'true',
      'true',
    ]);
    // The package's one avatar (InitialsAvatar), so a person reads the same
    // hue in a picker as everywhere else.
    expect(marks[0]?.getAttribute('data-hue')).not.toBeNull();
    expect(marks[1]?.getAttribute('data-hue')).toBeNull();
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '../src/components/initials-avatar.module.css'
      ),
      'utf8'
    );
    expect(css).toMatch(/\.avatar \{[^}]*border-radius: 50%;/);
    expect(css).toMatch(
      /\.avatar\[data-empty='true'\]\s*\{[^}]*border: 1\.3px dashed var\(--border-strong\);/
    );
  });
});

// A two-step menu (Filter: facets, then a facet's values): an option with
// keepOpen is a step, so the popover stays open for the host's next list.
describe('PickerPopover steps (PickerOption.keepOpen)', () => {
  const FACETS: PickerOption[] = [
    { value: 'status', label: 'Status', keepOpen: true },
    { value: 'priority', label: 'Priority', keepOpen: true },
  ];
  const STATUSES: PickerOption[] = [
    { value: 'back', label: 'Back to filters', keepOpen: true },
    { value: 'todo', label: 'Todo', group: 'Status' },
    { value: 'done', label: 'Done', group: 'Status' },
  ];

  /** A filter menu: the facet list, or the chosen facet's values. */
  function FilterHost({
    onStep,
    onValues,
  }: {
    onStep: (value: string | null) => void;
    onValues: (values: string[]) => void;
  }) {
    const [facet, setFacet] = useState<string | null>(null);
    const [values, setValues] = useState<string[]>([]);
    if (facet === null) {
      return (
        <PickerPopover
          label="Filter facets"
          options={FACETS}
          value={null}
          action
          trigger="Filter"
          triggerLabel="Filter"
          data-slot="filter-menu"
          data-testid="filter-popup"
          onChange={(next) => {
            onStep(next);
            setFacet(next);
          }}
        />
      );
    }
    return (
      <PickerPopover
        label={`${facet} values`}
        options={STATUSES}
        value={values}
        multiple
        open
        trigger="Filter"
        triggerLabel="Filter"
        data-slot="filter-menu"
        onChange={(next) => {
          if (next.includes('back')) {
            onStep('back');
            setFacet(null);
            return;
          }
          onValues(next);
          setValues(next);
        }}
      />
    );
  }

  test('a step keeps it open, clears the search and resets the active row', () => {
    const steps: (string | null)[] = [];
    function Steps() {
      const [label, setLabel] = useState('Filter facets');
      return (
        <PickerPopover
          label={label}
          options={FACETS}
          value={null}
          action
          trigger="Filter"
          triggerLabel="Filter"
          onChange={(next) => {
            steps.push(next);
            setLabel(`${next ?? ''} values`);
          }}
        />
      );
    }
    render(<Steps />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(combobox(), { target: { value: 'priority' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(steps).toEqual(['priority']);
    // Still open, renamed by the host, the search cleared and focused.
    const dialog = screen.getByRole('dialog', { name: 'priority values' });
    expect(dialog).toBeTruthy();
    expect(combobox().value).toBe('');
    expect(document.activeElement).toBe(combobox());
    // The active row starts over at the first option, not a stale key.
    const active = document.getElementById(
      combobox().getAttribute('aria-activedescendant') ?? ''
    );
    expect(active?.textContent).toContain('Status');
    // A step is never drawn as chosen.
    expect(
      screen
        .getByRole('option', { name: 'Priority' })
        .getAttribute('aria-selected')
    ).toBe('false');
  });

  test('facet, values, back: one popover throughout, with the host hook on it', async () => {
    const steps: (string | null)[] = [];
    const picked: string[][] = [];
    render(
      <FilterHost
        onStep={(value) => steps.push(value)}
        onValues={(values) => picked.push(values)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const facets = screen.getByRole('dialog', { name: 'Filter facets' });
    expect(facets.getAttribute('data-slot')).toBe('filter-menu');
    expect(facets.getAttribute('data-testid')).toBe('filter-popup');
    // The library's own hook is kept beside the host's.
    expect(facets.hasAttribute('data-picker-popup')).toBe(true);
    fireEvent.click(screen.getByRole('option', { name: 'Status' }));
    expect(steps).toEqual(['status']);
    const values = screen.getByRole('dialog', { name: 'status values' });
    expect(values.getAttribute('data-slot')).toBe('filter-menu');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Todo' }));
      await Promise.resolve();
    });
    expect(picked).toEqual([['todo']]);
    // In multiple mode a step reaches onChange directly: it is not a
    // value, so nothing is pending and no "Saving" is announced.
    fireEvent.click(screen.getByRole('option', { name: 'Back to filters' }));
    expect(steps).toEqual(['status', 'back']);
    expect(document.querySelector('[data-pending="true"]')).toBeNull();
    expect(
      screen
        .getAllByRole('status')
        .map((region) => region.textContent)
        .filter((text) => text?.includes('Saving'))
    ).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Filter facets' })).toBeTruthy();
  });

  test('searchLabel names the search box apart from the dialog and the list', () => {
    render(
      <PickerPopover
        label="Filter facets"
        searchLabel="Add filter"
        searchPlaceholder="Add filter…"
        options={FACETS}
        value={null}
        action
        trigger="Filter"
        triggerLabel="Filter"
        onChange={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('dialog', { name: 'Filter facets' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Filter facets' })).toBeTruthy();
    expect(combobox().getAttribute('aria-label')).toBe('Add filter');
  });

  test('shortcut: a keycap in the search row and aria-keyshortcuts on the trigger', () => {
    render(
      <PickerPopover
        label="Filter facets"
        shortcut="F"
        options={FACETS}
        value={null}
        action
        trigger="Filter"
        triggerLabel="Filter"
        onChange={() => undefined}
      />
    );
    const button = screen.getByRole('button', { name: 'Filter' });
    expect(button.getAttribute('aria-keyshortcuts')).toBe('F');
    fireEvent.click(button);
    const row = combobox().parentElement;
    const keycaps = Array.from(row?.querySelectorAll('kbd') ?? []).map(
      (kbd) => kbd.textContent
    );
    expect(keycaps).toContain('F');
  });

  test('a host data hook stays off the trigger while closed', () => {
    render(
      <PickerPopover
        label="Assignee"
        options={PEOPLE}
        value="ana"
        data-slot="assignee-menu"
        onChange={() => undefined}
      />
    );
    expect(document.querySelector('[data-slot="assignee-menu"]')).toBeNull();
    fireEvent.click(trigger());
    expect(screen.getByRole('dialog').getAttribute('data-slot')).toBe(
      'assignee-menu'
    );
  });
});

// onCreate: a new name typed into the search box becomes a trailing
// "Create" option. The host makes the option (here: appends it, and picks
// it); the picker runs the save contract around that.
describe('PickerPopover create row (onCreate)', () => {
  const START: PickerOption[] = [
    { value: 'bug', label: 'Bug' },
    { value: 'ux', label: 'UX' },
  ];

  function createRow(): HTMLElement | null {
    return screen.queryByRole('option', { name: /^Create/ });
  }

  /** A multiple picker whose host appends the created label and picks it
      once `make` settles. */
  function MultiCreate({
    make,
  }: {
    make: (name: string) => Promise<void> | void;
  }) {
    const [options, setOptions] = useState<PickerOption[]>(START);
    const [value, setValue] = useState<string[]>([]);
    return (
      <PickerPopover
        multiple
        label="Labels"
        placeholder="Add label"
        options={options}
        value={value}
        onChange={setValue}
        onCreate={async (name) => {
          await make(name);
          const id = name.toLowerCase();
          setOptions((list) => [...list, { value: id, label: name }]);
          setValue((list) => [...list, id]);
        }}
      />
    );
  }

  /** The single counterpart: the created option becomes the value. */
  function SingleCreate({
    make,
  }: {
    make: (name: string) => Promise<void> | void;
  }) {
    const [options, setOptions] = useState<PickerOption[]>(START);
    const [value, setValue] = useState<string | null>(null);
    return (
      <PickerPopover
        label="Project"
        placeholder="No project"
        options={options}
        value={value}
        onChange={setValue}
        onCreate={async (name) => {
          await make(name);
          const id = name.toLowerCase();
          setOptions((list) => [...list, { value: id, label: name }]);
          setValue(id);
        }}
      />
    );
  }

  test('offered only for a new name: not for an empty search or an exact label', () => {
    render(<MultiCreate make={() => undefined} />);
    fireEvent.click(trigger(/^Labels/));
    expect(createRow()).toBeNull();
    fireEvent.change(combobox(), { target: { value: '   ' } });
    expect(createRow()).toBeNull();
    // An exact label, case and outer spaces aside: no second "Bug".
    fireEvent.change(combobox(), { target: { value: ' bUG ' } });
    expect(createRow()).toBeNull();
    // A prefix of a label is still a new name.
    fireEvent.change(combobox(), { target: { value: 'Bu' } });
    expect(createRow()?.textContent).toBe('Create "Bu"');
    expect(optionNames()).toEqual(['Bug', 'Create "Bu"']);
  });

  test('the trailing row is an option the arrow keys reach; alone, it is the active one', () => {
    render(<MultiCreate make={() => undefined} />);
    fireEvent.click(trigger(/^Labels/));
    fireEvent.change(combobox(), { target: { value: 'u' } });
    // "Bug" and "UX" match; the create row comes last.
    expect(optionNames()).toEqual(['Bug', 'UX', 'Create "u"']);
    expect(activeOption()?.textContent).toBe('Bug');
    fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    expect(activeOption()).toBe(createRow());
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toBe('Bug');
    // Nothing else matches: Enter would create.
    fireEvent.change(combobox(), { target: { value: 'Perf' } });
    expect(activeOption()).toBe(createRow());
    expect(createRow()?.getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByText('No match')).toBeNull();
    expect(
      screen.getAllByRole('status', { hidden: true }).at(-1)?.textContent
    ).toBe('Create "Perf"');
  });

  test('Enter in a single picker creates the trimmed name and closes once it is saved', async () => {
    const made = deferred();
    const make = mock((_name: string) => made.promise);
    render(<SingleCreate make={make} />);
    fireEvent.click(trigger(/^Project/));
    fireEvent.change(combobox(), { target: { value: '  Atlas  ' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(make).toHaveBeenCalledWith('Atlas');
    // Open while it saves, with the pending note; the row waits.
    const dialog = screen.getByRole('dialog', { name: 'Project' });
    expect(within(dialog).getByText('Saving')).toBeTruthy();
    expect(trigger(/^Project/).getAttribute('data-pending')).toBe('true');
    expect(createRow()?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(make).toHaveBeenCalledTimes(1);
    await act(async () => {
      made.resolve();
      await made.promise;
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger(/^Project/));
    expect(trigger(/^Project/).getAttribute('aria-label')).toBe(
      'Project: Atlas'
    );
    expect(trigger(/^Project/).getAttribute('data-pending')).toBeNull();
  });

  test('a click in a multiple picker creates, clears the search and stays open', async () => {
    const make = mock((_name: string) => undefined);
    render(<MultiCreate make={make} />);
    fireEvent.click(trigger(/^Labels/));
    fireEvent.change(combobox(), { target: { value: 'Perf' } });
    const row = createRow();
    if (row === null) throw new Error('no create row');
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    expect(make).toHaveBeenCalledWith('Perf');
    expect(screen.getByRole('dialog', { name: 'Labels' })).toBeTruthy();
    expect(combobox().value).toBe('');
    expect(document.activeElement).toBe(combobox());
    expect(createRow()).toBeNull();
    expect(
      screen.getByRole('option', { name: 'Perf' }).getAttribute('aria-selected')
    ).toBe('true');
    expect(trigger(/^Labels/).getAttribute('aria-label')).toBe('Labels: Perf');
  });

  test('a rejection puts the name back in the search box and prints the error', async () => {
    const made = deferred();
    render(<MultiCreate make={() => made.promise} />);
    fireEvent.click(trigger(/^Labels/));
    fireEvent.change(combobox(), { target: { value: 'Perf' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    // Cleared at once, so the next name can be typed while this one saves.
    expect(combobox().value).toBe('');
    expect(within(screen.getByRole('dialog')).getByText('Saving')).toBeTruthy();
    await act(async () => {
      made.reject(new Error('Linear refused the label.'));
      await made.promise.catch(() => undefined);
    });
    const dialog = screen.getByRole('dialog', { name: 'Labels' });
    expect(combobox().value).toBe('Perf');
    expect(createRow()).not.toBeNull();
    expect(createRow()?.getAttribute('aria-disabled')).toBeNull();
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    expect(alert.textContent).toContain('Linear refused the label.');
    expect(within(dialog).queryByText('Saving')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Perf' })).toBeNull();
    expect(trigger(/^Labels/).getAttribute('aria-label')).toBe(
      'Labels: Add label'
    );
    // The next pick clears the error.
    await act(async () => {
      fireEvent.change(combobox(), { target: { value: '' } });
      fireEvent.click(screen.getByRole('option', { name: 'Bug' }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a single picker stays open with its text on a rejection; closed, the error goes under the trigger', async () => {
    render(<SingleCreate make={() => Promise.reject(new Error('No room.'))} />);
    fireEvent.click(trigger(/^Project/));
    fireEvent.change(combobox(), { target: { value: 'Atlas' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(combobox().value).toBe('Atlas');
    expect(
      within(screen.getByRole('dialog')).getByRole('alert').textContent
    ).toContain('No room.');
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No room.');
    expect(trigger(/^Project/).getAttribute('aria-describedby')).toBe(alert.id);
    expect(trigger(/^Project/).getAttribute('aria-label')).toBe(
      'Project: No project'
    );
  });

  test('createLabel words the row, and an action menu offers none', () => {
    render(
      <>
        <PickerPopover
          label="Folder"
          options={START}
          value={null}
          onChange={() => undefined}
          onCreate={() => undefined}
          createLabel={(name) => `New folder "${name}"`}
        />
        <PickerPopover
          label="Link task"
          options={START}
          value={null}
          action
          onChange={() => undefined}
          onCreate={() => undefined}
        />
      </>
    );
    fireEvent.click(trigger(/^Folder/));
    fireEvent.change(combobox(), { target: { value: 'notes' } });
    expect(
      screen.getByRole('option', { name: 'New folder "notes"' })
    ).toBeTruthy();
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    fireEvent.click(trigger(/^Link task/));
    fireEvent.change(combobox(), { target: { value: 'notes' } });
    expect(screen.queryByRole('option', { name: /notes/ })).toBeNull();
    expect(document.querySelector('[data-picker-empty]')?.textContent).toBe(
      'No match'
    );
  });

  test('LabelPicker forwards onCreate: a new label is made and added', async () => {
    function Labels() {
      const [choices, setChoices] = useState<LabelChoice[]>([
        { id: 'bug', name: 'Bug', color: '#eb5757' },
      ]);
      const [value, setValue] = useState<string[]>(['bug']);
      return (
        <LabelPicker
          labelOptions={choices}
          value={value}
          onChange={setValue}
          onCreate={(name) => {
            const id = `new-${name}`;
            setChoices((list) => [...list, { id, name }]);
            setValue((list) => [...list, id]);
          }}
        />
      );
    }
    render(<Labels />);
    fireEvent.click(trigger(/^Labels/));
    fireEvent.change(combobox(), { target: { value: 'bug' } });
    expect(createRow()).toBeNull();
    fireEvent.change(combobox(), { target: { value: 'Regression' } });
    await act(async () => {
      fireEvent.keyDown(combobox(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(screen.getByRole('dialog', { name: 'Labels' })).toBeTruthy();
    expect(combobox().value).toBe('');
    expect(trigger(/^Labels/).getAttribute('aria-label')).toBe(
      'Labels: Bug, Regression'
    );
  });
});
