import { runConformance } from '@dispatch/protocol-spec';
import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));

it('passes a claim through the stdio adapter', async () => {
  const report = await runConformance({
    adapter: `bun ${fileURLToPath(new URL('../src/conformance/stdio.ts', import.meta.url))}`,
    claims: ['envelope'],
    vectorsDir: fileURLToPath(new URL('fixtures/vectors', import.meta.url)),
  });
  expect(report.claims.envelope).toBe('pass');
  expect(report.implementation.name).toBe('dispatch-reference');
});

// Node's readline, unlike Bun's, ends a line at U+2028 and U+2029, so this
// runs the built bin under Node with both characters raw on its stdin.
it('reads lines at LF alone and escapes U+2028 and U+2029, under Node', () => {
  const body = 'a\u2028b\u2029c';
  const vector = {
    id: 'core.stdio.separators',
    title: 'A body with both separators',
    class: 'host-core',
    level: 'MUST',
    profile: 'core',
    sections: ['1.4'],
    given: { workItems: [{ id: 't-4a8cce' }], owner: 'human:wyat' },
    when: [
      {
        op: 'send',
        as: { address: 'human:wyat', canDecide: true },
        input: { to: ['task:t-4a8cce'], kind: 'message', body },
      },
    ],
  };
  const input = [
    { dmp: 'hello', kit: '1.0.0-draft.1' },
    { dmp: 'run', vector },
    { dmp: 'bye' },
  ]
    .map((m) => `${JSON.stringify(m)}\n`)
    .join('');
  const run = spawnSync('node', ['dist/conformance-adapter.js'], {
    cwd: pkg,
    input,
    encoding: 'utf8',
  });
  const lines = run.stdout.split('\n');
  expect({
    status: run.status,
    stderr: run.stderr,
    raw: /[\u2028\u2029]/.test(run.stdout),
    lines: lines.length,
  }).toEqual({ status: 0, stderr: '', raw: false, lines: 3 });
  const observation = JSON.parse(lines[1] ?? '') as {
    messages: { body: string }[];
  };
  expect(observation.messages.map((m) => m.body)).toEqual([body]);
});
