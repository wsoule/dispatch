import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';

import {
  CommandPaletteProvider,
  shortcutCode,
  useCommandPalette,
} from '../src/shell/command-palette';
import type { CommandPaletteApi, PaletteItem } from '../src/shell/types';

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const ITEMS: PaletteItem[] = [
  {
    id: 'week',
    label: 'Go to My week',
    section: 'Navigation',
    href: '/week',
    shortcut: ['G', 'W'],
  },
  {
    id: 'graph',
    label: 'Go to Graph',
    section: 'Navigation',
    href: '/graph',
    shortcut: ['G', 'G'],
  },
  {
    id: 'dark',
    label: 'Switch theme',
    section: 'Suggestions',
    shortcut: ['Ctrl', 'Shift', 'L'],
    onSelect: () => undefined,
  },
];

function setup() {
  const navigate = mock((_href: string) => undefined);
  render(
    <CommandPaletteProvider items={ITEMS} navigate={navigate}>
      <input aria-label="Search issues" />
      <textarea aria-label="Comment" />
      <div aria-label="Notes" contentEditable suppressContentEditableWarning>
        notes
      </div>
    </CommandPaletteProvider>
  );
  return { navigate };
}

describe('shortcutCode', () => {
  test('registers one or two plain keys, case-insensitively', () => {
    expect(shortcutCode(['G', 'W'])).toBe('g w');
    expect(shortcutCode(['N'])).toBe('n');
    expect(shortcutCode(['Ctrl', 'Shift', 'L'])).toBeNull();
    expect(shortcutCode(['⌘', 'K'])).toBeNull();
    expect(shortcutCode(['Esc'])).toBeNull();
    expect(shortcutCode([])).toBeNull();
  });
});

describe('two-key shortcuts', () => {
  test('G then W navigates', () => {
    const { navigate } = setup();
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'w' });
    expect(navigate).toHaveBeenCalledWith('/week');
  });

  test('a repeated key (G G) works and Shift does not break a sequence', () => {
    const { navigate } = setup();
    fireEvent.keyDown(document.body, { key: 'G', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'Shift', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(navigate).toHaveBeenCalledWith('/graph');
  });

  test('is ignored while typing in inputs, textareas and contenteditable', () => {
    const { navigate } = setup();
    for (const name of ['Search issues', 'Comment', 'Notes']) {
      const field = screen.getByLabelText(name);
      fireEvent.keyDown(field, { key: 'g' });
      fireEvent.keyDown(field, { key: 'w' });
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  test('the second key must follow within 1.2s', () => {
    jest.useFakeTimers();
    const { navigate } = setup();
    fireEvent.keyDown(document.body, { key: 'g' });
    act(() => {
      jest.advanceTimersByTime(1300);
    });
    fireEvent.keyDown(document.body, { key: 'w' });
    expect(navigate).not.toHaveBeenCalled();
  });

  test('modified keys and modifier-only shortcuts do not fire', () => {
    const { navigate } = setup();
    fireEvent.keyDown(document.body, { key: 'g', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'w' });
    expect(navigate).not.toHaveBeenCalled();
  });

  test('"?" opens the shortcuts sheet listing the registered keys', () => {
    setup();
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(sheet.textContent).toContain('Go to My week');
    expect(sheet.textContent).toContain('Open the command palette');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('shortcuts pause while a modal dialog is open', () => {
    const { navigate } = setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    // The palette input is focused, so the keys type instead.
    const field = screen.getByRole('combobox');
    fireEvent.keyDown(field, { key: 'g' });
    fireEvent.keyDown(field, { key: 'w' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('isSequencePending', () => {
  // A host reads it from the palette API (a list's row commands).
  function Probe({ onReady }: { onReady: (api: CommandPaletteApi) => void }) {
    onReady(useCommandPalette());
    return null;
  }

  function setupProbe() {
    let api: CommandPaletteApi | null = null;
    const navigate = mock((_href: string) => undefined);
    render(
      <CommandPaletteProvider items={ITEMS} navigate={navigate}>
        <Probe
          onReady={(next) => {
            api = next;
          }}
        />
      </CommandPaletteProvider>
    );
    return {
      pending: () => api?.isSequencePending() ?? null,
      navigate,
    };
  }

  test('true after G, false once the second key lands', () => {
    const { pending, navigate } = setupProbe();
    expect(pending()).toBe(false);
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(pending()).toBe(true);
    fireEvent.keyDown(document.body, { key: 'w' });
    expect(pending()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/week');
  });

  test('false after the sequence window runs out', () => {
    jest.useFakeTimers();
    const { pending } = setupProbe();
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(pending()).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1300);
    });
    expect(pending()).toBe(false);
  });

  test('a key that starts no sequence, or a key that does not finish one, leaves it false', () => {
    const { pending } = setupProbe();
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(pending()).toBe(false);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'q' });
    expect(pending()).toBe(false);
  });

  test('a row handler that yields while pending lets G S reach the palette', () => {
    // The host's own `s` (Status…) runs in React before the palette's
    // document listener; it checks isSequencePending() and stays out of
    // the way, so the chord still navigates.
    const navigate = mock((_href: string) => undefined);
    const rowCommand = mock(() => undefined);
    function Row() {
      const palette = useCommandPalette();
      return (
        <button
          type="button"
          onKeyDown={(event) => {
            if (event.key !== 's' || palette.isSequencePending()) return;
            event.preventDefault();
            rowCommand();
          }}
        >
          ENG-12
        </button>
      );
    }
    render(
      <CommandPaletteProvider
        items={[
          {
            id: 'settings',
            label: 'Go to Settings',
            section: 'Navigation',
            href: '/settings',
            shortcut: ['G', 'S'],
          },
        ]}
        navigate={navigate}
      >
        <Row />
      </CommandPaletteProvider>
    );
    const row = screen.getByRole('button', { name: 'ENG-12' });
    fireEvent.keyDown(row, { key: 'g' });
    fireEvent.keyDown(row, { key: 's' });
    expect(rowCommand).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/settings');
    // Without the chord, `s` is the row's.
    fireEvent.keyDown(row, { key: 's' });
    expect(rowCommand).toHaveBeenCalledTimes(1);
  });
});
