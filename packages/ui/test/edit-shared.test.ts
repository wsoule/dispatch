import { describe, expect, test } from 'bun:test';

import { AVATAR_HUES, avatarHue } from '../src/components/initials-avatar';
import { foldText, toggleValue, withCount } from '../src/edit/shared';
import {
  filterOptions,
  groupOptions,
  initials,
  isCompleteDate,
  isHexColor,
  type PickerOption,
  placePopover,
  saveErrorMessage,
  valueKey,
} from '../src/index';

// Pure helpers of the edit family: search matching, grouping, initials,
// the swatch colour guard, the save contract's value keys and messages,
// and the popover placement geometry.

const PEOPLE: PickerOption[] = [
  { value: 'ana', label: 'Ana Moreno', hint: 'ana' },
  { value: 'ben', label: 'Ben Okafor', keywords: ['ben@northwind.test'] },
  { value: 'jose', label: 'José Álvarez' },
  { value: 'dev', label: 'Dev Patel', group: 'Platform' },
  { value: 'chloe', label: 'Chloé Dubois', group: 'Design' },
  { value: 'eli', label: 'Eli Brandt', group: 'Platform' },
];

describe('search matching', () => {
  test.each([
    ['', ['ana', 'ben', 'jose', 'dev', 'chloe', 'eli']],
    ['ana', ['ana']],
    ['  MORENO ', ['ana']],
    ['jose', ['jose']],
    ['alvarez jo', ['jose']],
    ['chloe', ['chloe']],
    ['northwind', ['ben']],
    ['e', ['ana', 'ben', 'jose', 'dev', 'chloe', 'eli']],
    ['zzz', []],
  ])('%p finds %p', (query, expected) => {
    expect(filterOptions(PEOPLE, query).map((o) => o.value)).toEqual(expected);
  });

  test('folding drops accents and case', () => {
    expect(foldText('ÉLODIE Ñandú')).toBe('elodie nandu');
  });
});

describe('grouping', () => {
  test('ungrouped first, then groups in first-seen order', () => {
    const groups = groupOptions(PEOPLE);
    expect(groups.map((g) => g.heading)).toEqual([null, 'Platform', 'Design']);
    expect(groups[1].options.map((o) => o.value)).toEqual(['dev', 'eli']);
  });

  test('no options, no groups', () => {
    expect(groupOptions([])).toEqual([]);
  });
});

describe('small helpers', () => {
  test.each([
    ['Ana Moreno', 'AM'],
    ['ana maría moreno', 'AM'],
    ['dev', 'D'],
    ['  ', '?'],
    ['  Mary Ann  de la Cruz ', 'MC'],
    ['Élodie', 'É'],
    ['élodie roux', 'ÉR'],
    // Not locale-sensitive: a Turkish locale must not make "i" → "İ".
    ['ivo ilic', 'II'],
    ['🙂 Smile', '🙂S'],
  ])('initials(%p) is %p', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  test('avatarHue is one of the decorative hues, the same for the same name', () => {
    const names = ['Ana Moreno', 'Ben Carter', 'Chloe Diaz', 'Dev Patel'];
    for (const name of names) {
      expect(AVATAR_HUES).toContain(avatarHue(name));
      expect(avatarHue(name)).toBe(avatarHue(name));
      // Case and surrounding space do not move a person to another hue.
      expect(avatarHue(` ${name.toUpperCase()} `)).toBe(avatarHue(name));
    }
    // Different people spread over more than one hue.
    expect(new Set(names.map(avatarHue)).size).toBeGreaterThan(1);
  });

  test.each([
    ['#bec2c8', true],
    ['#FFF', true],
    ['#ffffff80', true],
    ['#abcd', true],
    ['red', false],
    ['#ggg', false],
    ['#fff; background-image: url(x)', false],
    ['rgb(0 0 0)', false],
    ['', false],
  ])('isHexColor(%p) is %p', (color, expected) => {
    expect(isHexColor(color)).toBe(expected);
  });

  test('toggleValue adds and removes', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
  });

  test('withCount fills the template', () => {
    expect(withCount('{count} options', 3)).toBe('3 options');
  });

  test.each([
    ['2026-10-21', true],
    ['0002-10-21', false],
    ['202-10-21', false],
    ['', false],
    ['2026-1-21', false],
  ])('isCompleteDate(%p) is %p', (text, expected) => {
    expect(isCompleteDate(text)).toBe(expected);
  });
});

describe('save contract helpers', () => {
  test('lists compare as sets, scalars as themselves', () => {
    expect(valueKey(['b', 'a'])).toBe(valueKey(['a', 'b']));
    expect(valueKey(null)).toBe(valueKey(undefined));
    expect(valueKey('a')).not.toBe(valueKey(['a']));
    expect(valueKey(3)).toBe('3');
  });

  test('messages come from the rejection when it has one', () => {
    expect(saveErrorMessage(new Error('Linear said no'), 'x')).toBe(
      'Linear said no'
    );
    expect(saveErrorMessage('plain', 'x')).toBe('plain');
    expect(saveErrorMessage(new Error('  '), 'Could not save.')).toBe(
      'Could not save.'
    );
    expect(saveErrorMessage({ code: 1 }, 'Could not save.')).toBe(
      'Could not save.'
    );
  });
});

describe('placePopover', () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = (top: number, left: number, w = 120, h = 28) => ({
    top,
    bottom: top + h,
    left,
    right: left + w,
  });

  test('below the trigger when it fits', () => {
    const p = placePopover({
      anchor: anchor(100, 200),
      size: { width: 280, height: 300 },
      viewport,
    });
    expect(p).toMatchObject({ side: 'below', left: 200, top: 132 });
    expect(p.bottom).toBeNull();
    expect(p.maxHeight).toBe(800 - 128 - 4 - 8);
  });

  test('flips above at the bottom edge when there is more room there', () => {
    const p = placePopover({
      anchor: anchor(700, 200),
      size: { width: 280, height: 300 },
      viewport,
    });
    expect(p.side).toBe('above');
    expect(p.top).toBeNull();
    expect(p.bottom).toBe(800 - 700 + 4);
    expect(p.maxHeight).toBe(700 - 4 - 8);
  });

  test('stays below when it does not fit but below is still the roomier side', () => {
    const p = placePopover({
      anchor: anchor(300, 200),
      size: { width: 280, height: 600 },
      viewport,
    });
    expect(p.side).toBe('below');
    expect(p.maxHeight).toBe(800 - 328 - 4 - 8);
  });

  test('aligns to the trigger’s right edge near the viewport’s right edge', () => {
    const p = placePopover({
      anchor: anchor(100, 880, 100),
      size: { width: 280, height: 200 },
      viewport,
    });
    expect(p.left).toBe(980 - 280);
  });

  test("align 'end' lines up the right edges, and flips at the left edge", () => {
    const end = placePopover({
      anchor: anchor(100, 600, 60),
      size: { width: 280, height: 200 },
      viewport,
      align: 'end',
    });
    expect(end.left).toBe(660 - 280);
    const flipped = placePopover({
      anchor: anchor(100, 20, 60),
      size: { width: 280, height: 200 },
      viewport,
      align: 'end',
    });
    expect(flipped.left).toBe(20);
  });

  test('clamped inside the margins, never wider than the viewport', () => {
    const narrow = { width: 320, height: 600 };
    const p = placePopover({
      anchor: anchor(100, 4, 40),
      size: { width: 400, height: 200 },
      viewport: narrow,
    });
    expect(p.width).toBe(304);
    expect(p.left).toBe(8);
  });
});
