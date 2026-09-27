import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the built bin under Node, which is what a third party runs.
const pkg = fileURLToPath(new URL('..', import.meta.url));
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('runs under Node and writes the JSON and JUnit reports', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-bin-')));
  const run = spawnSync(
    'node',
    [
      'dist/bin.js',
      '--adapter',
      'bun test/fixtures/adapters/fixture.ts pass',
      '--claim',
      'core',
      '--vectors',
      'test/fixtures/vectors',
      '--report',
      join(dir, 'r.json'),
      '--junit',
      join(dir, 'r.xml'),
    ],
    { cwd: pkg, encoding: 'utf8' }
  );
  expect(run.status).toBe(0);
  expect(
    (
      JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as {
        claims: unknown;
      }
    ).claims
  ).toEqual({ core: 'pass' });
  expect(existsSync(join(dir, 'r.xml'))).toBe(true);
});

it('exits 1 when a claim fails and 2 on a usage error', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-bin-')));
  const fail = spawnSync(
    'node',
    [
      'dist/bin.js',
      '--adapter',
      'bun test/fixtures/adapters/fixture.ts unsupported-must',
      '--claim',
      'envelope',
      '--vectors',
      'test/fixtures/vectors',
      '--report',
      join(dir, 'r.json'),
    ],
    { cwd: pkg }
  );
  const usage = spawnSync('node', ['dist/bin.js', '--claim', 'core'], {
    cwd: pkg,
  });
  const unknownFlag = spawnSync(
    'node',
    ['dist/bin.js', '--adapter', 'x', '--nope'],
    { cwd: pkg }
  );
  expect([fail.status, usage.status, unknownFlag.status]).toEqual([1, 2, 2]);
});

it('refuses a --timeout-ms above what setTimeout can hold', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-bin-')));
  const run = (ms: string) =>
    spawnSync(
      'node',
      [
        'dist/bin.js',
        '--adapter',
        'bun test/fixtures/adapters/fixture.ts pass',
        '--timeout-ms',
        ms,
        '--report',
        join(dir, 'r.json'),
      ],
      { cwd: pkg, encoding: 'utf8' }
    );
  const results = ['2147483648', '3000000000', '0'].map((ms) => {
    const r = run(ms);
    return [ms, r.status, r.stderr.startsWith('--timeout-ms must be')];
  });
  expect(results).toEqual([
    ['2147483648', 2, true],
    ['3000000000', 2, true],
    ['0', 2, true],
  ]);
});

it('carries U+2028 and U+2029 both ways under Node', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-bin-')));
  const report = join(dir, 'r.json');
  const run = spawnSync(
    'node',
    [
      'dist/bin.js',
      '--adapter',
      'bun test/fixtures/adapters/fixture.ts echo',
      '--claim',
      'envelope',
      '--vectors',
      'test/fixtures/vectors-separators',
      '--report',
      report,
    ],
    { cwd: pkg, encoding: 'utf8' }
  );
  const { vectors } = JSON.parse(readFileSync(report, 'utf8')) as {
    vectors: { id: string; outcome: string; reasons: string[] }[];
  };
  expect(vectors.map((v) => [v.id, v.outcome, v.reasons])).toEqual([
    ['env.separators.echo', 'pass', []],
  ]);
  expect(run.status).toBe(0);
});

// Node raises EPIPE on a write to an adapter whose stdin is gone; unhandled,
// it would crash the runner instead of failing the vector.
it('survives an adapter that exits or closes its stdin after hello, under Node', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-bin-')));
  // Bun 1.3 ignores fs.closeSync(0), so the stdin-closing mode runs on Node.
  const adapters: [string, string][] = [
    ['exit-after-hello', 'bun'],
    ['close-stdin-after-hello', 'node'],
  ];
  const modes = adapters.map(([mode]) => mode);
  const results = adapters.map(([mode, runtime]) => {
    const report = join(dir, `${mode}.json`);
    const run = spawnSync(
      'node',
      [
        'dist/bin.js',
        '--adapter',
        `${runtime} test/fixtures/adapters/fixture.ts ${mode}`,
        '--claim',
        'envelope',
        '--vectors',
        'test/fixtures/vectors',
        '--report',
        report,
      ],
      { cwd: pkg, encoding: 'utf8' }
    );
    const { claims, vectors } = (
      existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : {}
    ) as {
      claims?: unknown;
      vectors?: { id: string; outcome: string }[];
    };
    return {
      mode,
      status: run.status,
      stderr: run.stderr.includes('EPIPE') ? run.stderr : '',
      claims,
      must: vectors?.find((v) => v.id === 'env.basic.must')?.outcome,
    };
  });
  expect(results).toEqual(
    modes.map((mode) => ({
      mode,
      status: 1,
      stderr: '',
      claims: { envelope: 'fail' },
      must: 'adapter-error',
    }))
  );
}, 30_000);
