import { describe, expect, test } from 'bun:test';

import { keyAction } from './appNav';
import {
  type GlobalKeyboardContext,
  type GlobalKeyCommand,
  resolveChordKey,
} from './keyboard';
import { buildShortcutGroups, GOTO_CHORDS } from './shortcutGroups';

const ARMED: GlobalKeyboardContext = {
  isTyping: false,
  modalOpen: false,
  pendingPrefix: 'g',
};

/** The command an armed `g` plus this letter resolves to, or null. */
function chord(letter: string): GlobalKeyCommand | null {
  return resolveChordKey(
    { key: letter.toLowerCase(), metaKey: false, ctrlKey: false },
    ARMED
  );
}

describe('buildShortcutGroups', () => {
  const groups = buildShortcutGroups('Ctrl');
  const titles = groups.map((g) => g.title);

  test('has the six groups of the old dialog, in its order', () => {
    expect(titles).toEqual(['Shell', 'Go to', 'View', 'List', 'Live', 'Task']);
  });

  test('every row is one shortcut with one or more caps, with labels unique in a group', () => {
    for (const group of groups) {
      const labels = group.rows.map((row) => row.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const row of group.rows) {
        expect(row.keys.length).toBeGreaterThan(0);
        for (const key of row.keys) expect(key).not.toBe('');
        // Alternates are their own rows: no cap is a "/" or a pair.
        for (const key of row.keys) expect(key).not.toMatch(/\//);
      }
    }
  });

  test('the modifier is the given label, never a hard-coded ⌘', () => {
    const caps = groups.flatMap((g) => g.rows.flatMap((row) => row.keys));
    expect(caps).not.toContain('⌘');
    expect(caps.filter((key) => key === 'Ctrl').length).toBeGreaterThan(0);
    expect(buildShortcutGroups('⌘')[0]?.rows[0]?.keys).toEqual(['⌘', 'K']);
  });

  test('alternates became their own rows', () => {
    const list = groups.find((g) => g.title === 'List');
    expect(list?.rows.slice(0, 2)).toEqual([
      { label: 'Move down', keys: ['J'] },
      { label: 'Move up', keys: ['K'] },
    ]);
    const goto = groups.find((g) => g.title === 'Go to');
    expect(goto?.rows.slice(-2)).toEqual([
      { label: 'Back', keys: ['Ctrl', '['] },
      { label: 'Forward', keys: ['Ctrl', ']'] },
    ]);
  });

  test('lists only the places the app has', () => {
    const labels = groups.flatMap((g) => g.rows.map((row) => row.label));
    for (const absent of [
      'Inbox',
      'Overview',
      'Assistant',
      'Projects',
      'Toggle sidebar',
      'Home',
    ]) {
      expect(labels).not.toContain(absent);
    }
  });
});

describe('the Go to chords mirror lib/keyboard.ts', () => {
  test('every listed chord resolves to a nav action', () => {
    for (const { key } of GOTO_CHORDS) {
      const command = chord(key);
      expect(command).not.toBeNull();
      if (command === null) continue;
      const action = keyAction(command);
      expect(action).not.toBeNull();
      expect(action).not.toBe('swallow');
    }
  });

  test('every chord the resolver knows is listed, aliases by the place they reach', () => {
    // `g h` and `g c` are their own commands but land where `g o` does, so
    // chords compare by the nav action keyAction gives them.
    const place = (command: GlobalKeyCommand): string =>
      JSON.stringify(keyAction(command));
    const listed = new Set(
      GOTO_CHORDS.map(({ key }) => chord(key))
        .filter((command): command is GlobalKeyCommand => command !== null)
        .map(place)
    );
    const known = new Set<string>();
    for (let code = 97; code <= 122; code++) {
      const command = chord(String.fromCharCode(code));
      if (command !== null) known.add(place(command));
    }
    expect(known.size).toBeGreaterThan(0);
    expect([...known].sort()).toEqual([...listed].sort());
  });

  test('the chord rows are drawn as G then the letter', () => {
    const goto = buildShortcutGroups('Ctrl').find((g) => g.title === 'Go to');
    const chords = goto?.rows.filter((row) => row.keys[0] === 'G') ?? [];
    expect(chords.map((row) => row.keys)).toEqual(
      GOTO_CHORDS.map(({ key }) => ['G', key])
    );
    expect(chords.find((row) => row.label === 'Graph')?.keys).toEqual([
      'G',
      'G',
    ]);
  });
});
