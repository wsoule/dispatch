import { describe, expect, test } from 'bun:test';

import { containerIconSource } from './containerIcon';

describe('containerIconSource', () => {
  test('no icon draws the kind glyph', () => {
    expect(containerIconSource(null)).toBeNull();
    expect(containerIconSource('  ')).toBeNull();
    expect(containerIconSource('::')).toBeNull();
  });

  test('an emoji draws as itself', () => {
    expect(containerIconSource('🚀')).toEqual({ kind: 'emoji', emoji: '🚀' });
  });

  test('a Linear icon name, or its shortcode, is looked up lowercased', () => {
    expect(containerIconSource('Rocket')).toEqual({
      kind: 'named',
      name: 'rocket',
    });
    expect(containerIconSource(':rocket:')).toEqual({
      kind: 'named',
      name: 'rocket',
    });
  });
});
