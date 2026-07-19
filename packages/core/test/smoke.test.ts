import { describe, expect, it } from 'bun:test';

import { CORE_VERSION } from '../src/index.js';

describe('smoke', () => {
  it('imports the package', () => {
    expect(CORE_VERSION).toBe('0.0.1');
  });
});
