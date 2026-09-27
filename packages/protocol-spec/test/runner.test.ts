import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdapterError } from '../src/adapterProcess.js';
import { parseDeviations, parseTckAttestation } from '../src/deviations.js';
import { loadRegistry } from '../src/registries.js';
import type { RegistryEntry } from '../src/registries.js';
import { claimOutcome, runConformance } from '../src/runner.js';
import type { RunOptions } from '../src/runner.js';
import type { Hello, VectorResult } from '../src/types.js';

const fixture = (p: string): string =>
  fileURLToPath(new URL(`fixtures/${p}`, import.meta.url));
const adapter = (mode: string, extra = ''): string =>
  `bun ${fixture('adapters/fixture.ts')} ${mode} ${extra}`.trim();
// The fixture adapter in a patch mode, spreading `patch` over its reply.
const patched = (mode: string, patch: object): string =>
  adapter(mode, `'${JSON.stringify(patch)}'`);
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
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-crash-')));
    const starts = join(dir, 'starts');
    const report = await runConformance({
      adapter: adapter('crash-always', starts),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    const ran = report.vectors.filter((v) => v.outcome !== 'skipped');
    expect(ran.every((v) => v.outcome === 'adapter-error')).toBe(true);
    expect(readFileSync(starts, 'utf8')).toBe('started\n'.repeat(4));
    expect(ran.at(-1)?.reasons).toEqual(['the adapter was restarted 3 times']);
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

  it('the adapter never sees then or an unresolved runner symbol', async () => {
    const report = await runConformance({
      adapter: adapter('pass'),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    expect(report.vectors.map((v) => [v.id, v.outcome, v.reasons])).toEqual([
      ['env.basic.must', 'pass', []],
      ['env.basic.should', 'pass', []],
      ['env.basic.may', 'skipped', ['capability x-cap not declared']],
      ['core.basic.must', 'pass', []],
      ['core.basic.system', 'pass', []],
      ['core.basic.gate', 'pass', []],
    ]);
  });

  it('a vector needing an unimplemented gate type is not applicable once every registered type is declared', async () => {
    const gateTypes = loadRegistry()['gate-types'].map((g) => g.value);
    const report = await runConformance({
      adapter: patched('patch-hello', { gateTypes }),
      claims: ['core'],
      vectorsDir: fixture('vectors'),
    });
    expect(report.vectors.find((v) => v.id === 'core.basic.gate')).toEqual({
      id: 'core.basic.gate',
      class: 'host-core',
      level: 'MUST',
      profile: 'core',
      outcome: 'not-applicable',
      reasons: ['every registered gate type is implemented'],
    });
    expect(report.classes['host-core']?.notApplicable).toBe(1);
    expect(report.claims.core).toBe('pass');
  });

  it('refuses a malformed hello before any vector runs', async () => {
    const cases: [object, string][] = [
      [{ dmp: 'hi' }, 'expected dmp "hello"'],
      [{ implementation: { name: 'x' } }, 'implementation'],
      [{ classes: ['envelope', 'quantum'] }, 'classes'],
      [{ profiles: ['enterprise'] }, 'profiles'],
      [{ capabilities: [1] }, 'capabilities'],
      [{ systemAddress: '' }, 'systemAddress'],
      [{ gateTypes: 'wake' }, 'gateTypes'],
      [{ render: { quotePrefix: '', header: '^x', hostLines: [] } }, 'render'],
      [{ render: { quotePrefix: '> ', header: '[', hostLines: [] } }, 'render'],
      [
        { render: { quotePrefix: '> ', header: '^x', hostLines: ['('] } },
        'render',
      ],
    ];
    const errors = await Promise.all(
      cases.map(([patch]) =>
        runConformance({
          adapter: patched('patch-hello', patch),
          claims: ['envelope'],
          vectorsDir: fixture('vectors'),
        }).then(
          () => 'no error',
          (err: unknown) =>
            err instanceof AdapterError ? err.message : String(err)
        )
      )
    );
    expect(
      errors.map((e, i) =>
        e.startsWith(`bad hello: ${cases[i]?.[1] ?? ''}`) ? 'refused' : e
      )
    ).toEqual(cases.map(() => 'refused'));
  });

  it('fails a malformed observation as an adapter error', async () => {
    const cases: [object, string][] = [
      [{ steps: [{ ok: false }] }, 'steps'],
      [{ steps: [{ ok: 'yes' }] }, 'steps'],
      [{ messages: null }, 'messages'],
      [
        { messages: [{ id: 'm-1', from: 'human:wyat', kind: 'message' }] },
        'messages',
      ],
      [{ deliveries: [{ id: 'd-1', message: 'm-1' }] }, 'deliveries'],
      [{ calls: [{ message: 'm-1' }] }, 'calls'],
      [{ gateEffects: [1] }, 'gateEffects'],
      [{ voided: 'm-1' }, 'voided'],
      [{ channels: [{ name: 'auth', members: [1] }] }, 'channels'],
      [{ render: [{ step: '1', text: 'x' }] }, 'render'],
    ];
    const reports = await Promise.all(
      cases.map(([patch]) =>
        runConformance({
          adapter: patched('patch-observation', patch),
          claims: ['envelope'],
          vectorsDir: fixture('vectors'),
        })
      )
    );
    expect(
      reports.map((r) => {
        const must = r.vectors.find((v) => v.id === 'env.basic.must');
        return [r.claims.envelope, must?.outcome, must?.reasons];
      })
    ).toEqual(
      cases.map(([, key]) => [
        'fail',
        'adapter-error',
        [
          `malformed observation for env.basic.must: ${key} is not a list of the right shape`,
        ],
      ])
    );
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

  it('a dispatch-profile claim needs the adapter to run the dispatch profile', async () => {
    const without = await runConformance({
      adapter: adapter('pass'),
      claims: ['core', 'dispatch-profile'],
      vectorsDir: fixture('vectors'),
    });
    const within = await runConformance({
      adapter: adapter('with-dispatch'),
      claims: ['core', 'dispatch-profile'],
      vectorsDir: fixture('vectors'),
    });
    expect(outcome(without, 'core.basic.dispatch-must')).toBe('skipped');
    expect(without.claims).toEqual({
      core: 'pass',
      'dispatch-profile': 'fail',
    });
    expect(outcome(within, 'core.basic.dispatch-must')).toBe('pass');
    expect(within.claims).toEqual({ core: 'pass', 'dispatch-profile': 'pass' });
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

describe('claimOutcome', () => {
  const hello: Hello = {
    dmp: 'hello',
    implementation: { name: 't', version: '0' },
    classes: ['envelope', 'host-core'],
    profiles: ['core', 'dispatch'],
    capabilities: [],
    systemAddress: 'agent:dispatch',
    gateTypes: ['wake', 'tool-approval'],
    render: { quotePrefix: '> ', header: '^\\[from ', hostLines: [] },
  };
  const gate = (
    value: string,
    status: RegistryEntry['status']
  ): RegistryEntry => ({
    value,
    scope: 'dispatch',
    status,
    since: '1.0.0-draft.1',
    section: '5.9',
    vectors: [],
  });
  const registry = {
    ...loadRegistry(),
    'gate-types': [
      gate('wake', 'permanent'),
      gate('tool-approval', 'permanent'),
      gate('memory', 'provisional'),
    ],
  };
  const result = (
    id: string,
    profile: VectorResult['profile'],
    outcome: VectorResult['outcome'] = 'pass'
  ): VectorResult => ({
    id,
    class: id.startsWith('env.') ? 'envelope' : 'host-core',
    level: 'MUST',
    profile,
    outcome,
    reasons: [],
  });
  const core = [result('env.a.must', 'core'), result('core.a.must', 'core')];
  const ran = [...core, result('core.a.dispatch', 'dispatch')];
  const opts: RunOptions = {
    adapter: 'unused',
    claims: ['core', 'dispatch-profile'],
  };

  it('a dispatch-profile claim needs every permanent gate type declared', () => {
    const judge = (gateTypes: string[]) =>
      claimOutcome(
        'dispatch-profile',
        ran,
        { ...hello, gateTypes },
        registry,
        opts
      );
    expect([judge(['wake', 'tool-approval']), judge(['wake'])]).toEqual([
      'pass',
      'fail',
    ]);
    expect(
      claimOutcome('core', ran, { ...hello, gateTypes: [] }, registry, opts)
    ).toBe('pass');
  });

  it('a dispatch-profile claim fails when no dispatch-profile vector ran', () => {
    const inapplicable = [
      ...core,
      result('core.a.dispatch', 'dispatch', 'not-applicable'),
    ];
    expect(
      [core, inapplicable].map((results) =>
        claimOutcome('dispatch-profile', results, hello, registry, opts)
      )
    ).toEqual(['fail', 'fail']);
    expect(claimOutcome('core', core, hello, registry, opts)).toBe('pass');
  });
});
