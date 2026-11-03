import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { isApplePlatform, useModKeyLabel } from '../src/index';

// isApplePlatform: the one platform test behind useModKeyLabel, exported so a
// host binding its own keys (Dispatch's quick open) answers to the modifier
// the labels show.

const platformBefore = Object.getOwnPropertyDescriptor(navigator, 'platform');
const agentDataBefore = Object.getOwnPropertyDescriptor(
  navigator,
  'userAgentData'
);

// Puts a navigator property back as it was: the own property restored, or
// deleted when it was only inherited, so no stub outlives its test.
function restore(key: string, before: PropertyDescriptor | undefined): void {
  if (before !== undefined) Object.defineProperty(navigator, key, before);
  else Reflect.deleteProperty(navigator, key);
}

afterEach(() => {
  cleanup();
  restore('platform', platformBefore);
  restore('userAgentData', agentDataBefore);
});

function stub(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, {
    configurable: true,
    get: () => value,
  });
}

describe('isApplePlatform', () => {
  test.each([
    ['MacIntel', true],
    ['iPhone', true],
    ['iPad', true],
    ['iPod touch', true],
    ['Win32', false],
    ['Linux x86_64', false],
  ] as const)('navigator.platform %p is Apple: %p', (platform, expected) => {
    stub('userAgentData', undefined);
    stub('platform', platform);
    expect(isApplePlatform()).toBe(expected);
  });

  test('userAgentData.platform wins over navigator.platform', () => {
    stub('platform', 'Win32');
    stub('userAgentData', { platform: 'macOS' });
    expect(isApplePlatform()).toBe(true);
    stub('platform', 'MacIntel');
    stub('userAgentData', { platform: 'Windows' });
    expect(isApplePlatform()).toBe(false);
  });

  test('useModKeyLabel follows it', () => {
    stub('userAgentData', undefined);
    stub('platform', 'MacIntel');
    expect(renderHook(() => useModKeyLabel()).result.current).toBe('⌘');
    stub('platform', 'Win32');
    expect(renderHook(() => useModKeyLabel()).result.current).toBe('Ctrl');
  });
});
