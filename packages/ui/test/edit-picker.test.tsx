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
  PickerMarkView,
  type PickerOption,
  PickerPopover,
  type SaveResult,
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

  test('a search box keeps Home and End for its caret', () => {
    render(<Host />);
    fireEvent.click(trigger());
    const box = combobox();
    const before = box.getAttribute('aria-activedescendant');
    const notPrevented = fireEvent.keyDown(box, { key: 'End' });
    // Not prevented, and the active option did not move.
    expect(notPrevented).toBe(true);
    expect(box.getAttribute('aria-activedescendant')).toBe(before);
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
