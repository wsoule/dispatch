import { describe, expect, test } from 'bun:test';

import { revealActionLabel } from './savedFile';

describe('revealActionLabel', () => {
  test('names Finder on macOS and the folder everywhere else', () => {
    expect(revealActionLabel(true)).toBe('Reveal in Finder');
    expect(revealActionLabel(false)).toBe('Show in folder');
  });

  test("reads the library's platform test by default", () => {
    const own = Object.getOwnPropertyDescriptor(navigator, 'platform');
    try {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        get: () => 'MacIntel',
      });
      expect(revealActionLabel()).toBe('Reveal in Finder');
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        get: () => 'Win32',
      });
      expect(revealActionLabel()).toBe('Show in folder');
    } finally {
      if (own === undefined) {
        Reflect.deleteProperty(navigator, 'platform');
      } else {
        Object.defineProperty(navigator, 'platform', own);
      }
    }
  });
});
