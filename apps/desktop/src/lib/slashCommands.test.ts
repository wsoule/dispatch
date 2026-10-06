import { describe, expect, test } from 'bun:test';

import { slashSuggestions } from './slashCommands';

const commands = ['compact', 'context', 'review', 'cost'].map((name) => ({
  name,
  description: `${name} it`,
  argumentHint: '',
}));

describe('slashSuggestions', () => {
  test('suggests by prefix while the command word is being typed', () => {
    expect(slashSuggestions('/co', commands).map((c) => c.name)).toEqual([
      'compact',
      'context',
      'cost',
    ]);
    expect(slashSuggestions('/', commands)).toHaveLength(4);
  });

  test('stops once the command is followed by arguments, or without a slash', () => {
    expect(slashSuggestions('/compact now', commands)).toEqual([]);
    expect(slashSuggestions('compact', commands)).toEqual([]);
    expect(slashSuggestions('', commands)).toEqual([]);
  });
});
