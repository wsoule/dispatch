import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

// The kit runs on plain Node, so its sources may not reach for Bun.
it('uses no Bun API in src/', () => {
  const src = new URL('../src/', import.meta.url);
  const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const text = readFileSync(new URL(f, src), 'utf8');
    expect({
      f,
      bun: text.includes('Bun.') || text.includes("from 'bun"),
    }).toEqual({
      f,
      bun: false,
    });
  }
});
