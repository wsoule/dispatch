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

it('survives an adapter that exits after hello, under Node', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-bin-')));
  // The write racing the adapter's exit raises EPIPE in some runs only (Bun
  // never reproduced it), so this repeats the run under Node.
  for (let i = 0; i < 5; i += 1) {
    const report = join(dir, `r${i}.json`);
    const run = spawnSync(
      'node',
      [
        'dist/bin.js',
        '--adapter',
        'bun test/fixtures/adapters/fixture.ts exit-after-hello',
        '--claim',
        'envelope',
        '--vectors',
        'test/fixtures/vectors',
        '--report',
        report,
      ],
      { cwd: pkg, encoding: 'utf8' }
    );
    expect({ status: run.status, epipe: run.stderr.includes('EPIPE') }).toEqual(
      { status: 1, epipe: false }
    );
    expect(
      (JSON.parse(readFileSync(report, 'utf8')) as { claims: unknown }).claims
    ).toEqual({ envelope: 'fail' });
  }
}, 30_000);
