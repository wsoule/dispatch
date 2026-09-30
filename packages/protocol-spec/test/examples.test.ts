import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { loadVectors } from '../src/load.js';

const appendix = readFileSync(
  new URL('../spec/appendix-e-examples.md', import.meta.url),
  'utf8'
);
const byId = new Map(loadVectors().vectors.map((v) => [v.id, v]));

// Each example is a vector's first input, so examples cannot drift.
it('ties every App. E example to a vector with the same input', () => {
  const blocks = [
    ...appendix.matchAll(/```json vector=([a-z0-9.-]+)\n([\s\S]*?)\n```/g),
  ];
  expect(blocks.length).toBeGreaterThan(0);
  for (const [, id = '', body = ''] of blocks) {
    const v = byId.get(id);
    expect({ id, exists: v !== undefined }).toEqual({ id, exists: true });
    const first = v?.when.find((s) => 'input' in s);
    expect({ id, input: JSON.parse(body) as unknown }).toEqual({
      id,
      input: first?.['input'],
    });
  }
});
