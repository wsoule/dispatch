import { describe, expect, test } from 'bun:test';

import { showArchiveToggle } from './archiveToggle';

describe('showArchiveToggle', () => {
  test('on + zero archived: stays visible so it can be switched back off', () => {
    expect(showArchiveToggle(true, 0)).toBe(true);
  });

  test('off + zero archived: hidden, nothing to reveal', () => {
    expect(showArchiveToggle(false, 0)).toBe(false);
  });

  test('off + some archived: visible so they can be revealed', () => {
    expect(showArchiveToggle(false, 3)).toBe(true);
  });

  test('on + some archived: visible', () => {
    expect(showArchiveToggle(true, 3)).toBe(true);
  });
});
