import { runConformance } from '@dispatch/protocol-spec';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

it('passes a claim through the stdio adapter', async () => {
  const report = await runConformance({
    adapter: `bun ${fileURLToPath(new URL('../src/conformance/stdio.ts', import.meta.url))}`,
    claims: ['envelope'],
    vectorsDir: fileURLToPath(new URL('fixtures/vectors', import.meta.url)),
  });
  expect(report.claims.envelope).toBe('pass');
  expect(report.implementation.name).toBe('dispatch-reference');
});
