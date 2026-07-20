import type { RunState } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { isTerminalRunState } from './runState';

describe('isTerminalRunState', () => {
  test.each([
    ['provisioning', false],
    ['running', false],
    ['awaiting-approval', false],
    ['finished', true],
    ['failed', true],
    ['cancelled', true],
  ] as [RunState, boolean][])('%s -> %s', (state, expected) => {
    expect(isTerminalRunState(state)).toBe(expected);
  });
});
