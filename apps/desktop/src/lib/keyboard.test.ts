import { describe, expect, test } from 'bun:test';

import type { KeyboardContext, KeyInput } from './keyboard';
import { resolveKeyCommand } from './keyboard';

const baseCtx: KeyboardContext = {
  isTyping: false,
  paletteOpen: false,
  peekOpen: false,
};

function key(k: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { key: k, metaKey: false, ctrlKey: false, ...mods };
}

describe('resolveKeyCommand', () => {
  test('Escape always resolves, even while typing', () => {
    expect(resolveKeyCommand(key('Escape'), baseCtx)).toBe('escape');
    expect(
      resolveKeyCommand(key('Escape'), { ...baseCtx, isTyping: true })
    ).toBe('escape');
  });

  test('cmd+k and ctrl+k open the palette regardless of typing state', () => {
    expect(resolveKeyCommand(key('k', { metaKey: true }), baseCtx)).toBe(
      'open-palette'
    );
    expect(resolveKeyCommand(key('K', { ctrlKey: true }), baseCtx)).toBe(
      'open-palette'
    );
    expect(
      resolveKeyCommand(key('k', { metaKey: true }), {
        ...baseCtx,
        isTyping: true,
      })
    ).toBe('open-palette');
  });

  test('bare "/" opens the palette only when not typing', () => {
    expect(resolveKeyCommand(key('/'), baseCtx)).toBe('open-palette');
    expect(
      resolveKeyCommand(key('/'), { ...baseCtx, isTyping: true })
    ).toBeNull();
  });

  test('"c" starts a new task only when not typing', () => {
    expect(resolveKeyCommand(key('c'), baseCtx)).toBe('new-task');
    expect(
      resolveKeyCommand(key('c'), { ...baseCtx, isTyping: true })
    ).toBeNull();
  });

  test('j/k/Enter drive list navigation only when not typing', () => {
    expect(resolveKeyCommand(key('j'), baseCtx)).toBe('list-down');
    expect(resolveKeyCommand(key('k'), baseCtx)).toBe('list-up');
    expect(resolveKeyCommand(key('Enter'), baseCtx)).toBe('list-confirm');
    expect(
      resolveKeyCommand(key('j'), { ...baseCtx, isTyping: true })
    ).toBeNull();
    expect(
      resolveKeyCommand(key('Enter'), { ...baseCtx, isTyping: true })
    ).toBeNull();
  });

  test('unrelated keys resolve to null', () => {
    expect(resolveKeyCommand(key('a'), baseCtx)).toBeNull();
    expect(resolveKeyCommand(key('Tab'), baseCtx)).toBeNull();
  });
});
