import { runConformance } from '@dispatch/protocol-spec';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

const stdio = fileURLToPath(
  new URL('../src/conformance/stdio.ts', import.meta.url)
);

// The kit's own runner over the adapter's stdio loop, on every a2a-binding
// vector; no TCK attestation, so the claim is judged on vectors alone.
it('passes the a2a-binding vectors through the stdio adapter', async () => {
  const report = await runConformance({
    adapter: `bun ${stdio}`,
    claims: ['a2a-binding'],
    vectorsOnly: true,
  });
  expect(report.implementation.name).toBe('dispatch-a2a-reference');
  expect(report.claims['a2a-binding']).toBe('vectors-only');
  expect(report.classes['a2a-binding']?.fail).toBe(0);
  expect(report.classes['a2a-binding']?.pass).toBeGreaterThan(0);
});
