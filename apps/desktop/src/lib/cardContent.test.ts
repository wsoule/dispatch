import { describe, expect, test } from 'bun:test';

import { cardRaw, contentKey } from './cardContent';

describe('cardRaw', () => {
  test('keeps a string and pretty-prints anything else', () => {
    expect(cardRaw('plain text')).toBe('plain text');
    expect(cardRaw({ kind: 'tool', tool: 'Bash' })).toBe(
      '{\n  "kind": "tool",\n  "tool": "Bash"\n}'
    );
  });

  test('never throws on a value JSON cannot hold', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(cardRaw(cycle)).toBe('(this step could not be shown as text)');
    expect(cardRaw(10n)).toBe('10');
  });
});

describe('contentKey', () => {
  test('is stable for the same content and changes with it', () => {
    expect(contentKey('abc')).toBe(contentKey('abc'));
    expect(contentKey('abc')).not.toBe(contentKey('abd'));
  });
});
