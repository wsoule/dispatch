import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDeviations, parseTckAttestation } from '../src/deviations.js';
import { runConformance } from '../src/runner.js';

const fixture = (p: string): string =>
  fileURLToPath(new URL(`fixtures/${p}`, import.meta.url));
const adapter = (mode: string, extra = ''): string =>
  `bun ${fixture('adapters/fixture.ts')} ${mode} ${extra}`.trim();
const outcome = (
  report: Awaited<ReturnType<typeof runConformance>>,
  id: string
) => report.vectors.find((v) => v.id === id)?.outcome;

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('runConformance', () => {
  it('passes a claim when every MUST passes', async () => {
    const report = await runConformance({
      adapter: adapter('pass'),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    expect(report.claims.core).toBe('pass');
    expect(report.classes.envelope).toEqual({
      pass: 2,
      fail: 0,
      skipped: 1,
      notApplicable: 0,
      shouldFailures: 0,
    });
  });

  it('counts a failing SHOULD without failing the claim', async () => {
    const report = await runConformance({
      adapter: adapter('should-fail'),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    expect(report.claims.core).toBe('pass');
    expect(report.classes.envelope?.shouldFailures).toBe(1);
  });

  it('skips an undeclared MAY and runs a declared one', async () => {
    const off = await runConformance({
      adapter: adapter('pass'),
      claims: ['envelope'],
      vectorsDir: fixture('vectors'),
    });
    const on = await runConformance({
      adapter: adapter('with-cap'),
      claims: ['envelope'],
      vectorsDir: fixture('vectors'),
    });
    expect([
      outcome(off, 'env.basic.may'),
      outcome(on, 'env.basic.may'),
    ]).toEqual(['skipped', 'pass']);
  });

  it('a MUST the adapter calls unsupported fails the claim', async () => {
    const report = await runConformance({
      adapter: adapter('unsupported-must'),
      claims: ['envelope'],
      vectorsDir: fixture('vectors'),
    });
    expect(outcome(report, 'env.basic.must')).toBe('skipped');
    expect(report.claims.envelope).toBe('fail');
  });

  it('a class with no applicable vector fails the claim', async () => {
    const report = await runConformance({
      adapter: adapter('pass'),
      claims: ['core', 'envelope'],
      vectorsDir: fixture('vectors-envelope-only'),
    });
    expect(report.claims).toEqual({ core: 'fail', envelope: 'pass' });
  });

  it('a crashed adapter fails the vector in flight and the claim, and the rest still run', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-crash-')));
    const report = await runConformance({
      adapter: adapter('crash-once', join(dir, 'state')),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    expect(outcome(report, 'env.basic.must')).toBe('adapter-error');
    expect(outcome(report, 'core.basic.must')).toBe('pass');
    expect(report.claims.core).toBe('fail');
  });

  it('gives up after three restarts', async () => {
    const report = await runConformance({
      adapter: adapter('crash-always'),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    expect(
      report.vectors
        .filter((v) => v.outcome !== 'skipped')
        .every((v) => v.outcome === 'adapter-error')
    ).toBe(true);
  });

  it('times out a hung vector and restarts the adapter', async () => {
    const report = await runConformance({
      adapter: adapter('hang'),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
      timeoutMs: 500,
    });
    expect(
      report.vectors.find((v) => v.id === 'env.basic.must')?.reasons.join(' ')
    ).toContain('timed out');
    expect(outcome(report, 'core.basic.must')).toBe('pass');
  });

  it('fails a malformed line', async () => {
    const report = await runConformance({
      adapter: adapter('malformed'),
      claims: ['envelope'],
      vectorsDir: fixture('vectors'),
    });
    expect(
      report.vectors.find((v) => v.id === 'env.basic.must')?.reasons.join(' ')
    ).toContain('malformed');
  });

  it('an adapter that exits after hello fails the next vector without crashing the runner', async () => {
    const report = await runConformance({
      adapter: adapter('exit-after-hello'),
      claims: ['envelope'],
      vectorsDir: fixture('vectors'),
    });
    expect(outcome(report, 'env.basic.must')).toBe('adapter-error');
    expect(report.claims.envelope).toBe('fail');
  });

  it('a failing dispatch-profile a2a-binding MUST fails the A2A claim beside dispatch-profile', async () => {
    const both = await runConformance({
      adapter: adapter('with-dispatch-fail'),
      claims: ['a2a-binding', 'dispatch-profile'],
      vectorsDir: fixture('vectors'),
      vectorsOnly: true,
    });
    const alone = await runConformance({
      adapter: adapter('with-dispatch-fail'),
      claims: ['a2a-binding'],
      vectorsDir: fixture('vectors'),
      vectorsOnly: true,
    });
    expect([
      outcome(both, 'a2a.basic.dispatch-must'),
      both.claims['a2a-binding'],
    ]).toEqual(['fail', 'fail']);
    expect([
      outcome(alone, 'a2a.basic.dispatch-must'),
      alone.claims['a2a-binding'],
    ]).toEqual([undefined, 'vectors-only']);
  });

  it('reports an A2A claim without an attestation as vectors-only, or fails it', async () => {
    const only = await runConformance({
      adapter: adapter('pass'),
      claims: ['a2a-binding'],
      vectorsDir: fixture('vectors'),
      vectorsOnly: true,
    });
    const bare = await runConformance({
      adapter: adapter('pass'),
      claims: ['a2a-binding'],
      vectorsDir: fixture('vectors'),
    });
    expect([only.claims['a2a-binding'], bare.claims['a2a-binding']]).toEqual([
      'vectors-only',
      'fail',
    ]);
  });

  it('copies a TCK attestation marked attested', async () => {
    const tckAttest = parseTckAttestation({
      commit: '263b9cfaf16a554bdfb166a7ba5b67716e946349',
      transport: 'http_json',
      level: 'must',
      result: 'pass',
      deviations: ['bounded-blocking-wait', 'application-json'],
    });
    const report = await runConformance({
      adapter: adapter('pass'),
      claims: ['a2a-binding'],
      vectorsDir: fixture('vectors'),
      tckAttest,
    });
    expect(report.claims['a2a-binding']).toBe('pass');
    expect(report.a2a?.tck?.attested).toBe(true);
    expect(report.a2a?.deviations).toEqual([
      'bounded-blocking-wait',
      'application-json',
    ]);
  });
});

describe('declared deviations', () => {
  it('accepts only requirements the kit does not test', () => {
    expect(
      parseDeviations([{ section: '9.3', summary: '/ws until F0' }])
    ).toHaveLength(1);
    expect(() =>
      parseDeviations([{ section: '6.2', summary: 'mode selection' }])
    ).toThrow('6.2');
  });

  it('refuses an A2A deviation §8.10 does not list', () => {
    expect(() =>
      parseTckAttestation({
        commit: 'x',
        transport: 'http_json',
        level: 'must',
        result: 'pass',
        deviations: ['no-streaming'],
      })
    ).toThrow('no-streaming');
  });
});
