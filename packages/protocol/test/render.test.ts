import { describe, expect, it } from 'bun:test';

import { firstLine } from '../src/render.js';

// Pushes and digests are tested by the kit's render vectors (vectors.test.ts).
describe('firstLine', () => {
  it('cuts on code points, never inside a surrogate pair', () => {
    expect(firstLine(`${'a'.repeat(78)}😀😀😀`)).toBe(`${'a'.repeat(78)}😀…`);
  });
});
