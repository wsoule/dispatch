// A scripted adapter for the runner tests: it answers each vector with the
// observation the fixture's own `then` describes, bent by the mode in argv[2].
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'pass';
const stateFile = process.argv[3] ?? '';
const root = new URL('../vectors/', import.meta.url);
const expected = new Map<string, unknown[]>();
for (const cls of readdirSync(root)) {
  for (const file of readdirSync(new URL(`${cls}/`, root))) {
    const parsed = JSON.parse(
      readFileSync(new URL(`${cls}/${file}`, root), 'utf8')
    ) as { vectors: { id: string; then: { steps?: unknown[] } }[] };
    for (const v of parsed.vectors) expected.set(v.id, v.then.steps ?? []);
  }
}
const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line) as {
    dmp: string;
    vector?: { id: string; level: string };
  };
  if (msg.dmp === 'hello') {
    const hello = {
      dmp: 'hello',
      implementation: { name: 'fixture', version: '0.0.0' },
      classes: ['envelope', 'host-core', 'a2a-binding'],
      profiles: mode.startsWith('with-dispatch')
        ? ['core', 'dispatch']
        : ['core'],
      capabilities: mode === 'with-cap' ? ['x-cap'] : [],
      systemAddress: 'agent:system',
      gateTypes: ['wake'],
      render: { quotePrefix: '> ', header: '^\\[from ', hostLines: [] },
    };
    // Answers hello, then dies before the first vector: the runner must not
    // crash on the write that follows (EPIPE), only fail the vector.
    if (mode === 'exit-after-hello') {
      process.stdout.write(`${JSON.stringify(hello)}\n`, () => process.exit(0));
      return;
    }
    write(hello);
    return;
  }
  if (msg.dmp === 'bye') process.exit(0);
  const v = msg.vector;
  if (v === undefined) return;
  if (mode === 'crash-always') process.exit(3);
  if (mode === 'crash-once' && !existsSync(stateFile)) {
    appendFileSync(stateFile, 'crashed');
    process.exit(3);
  }
  if (mode === 'hang' && v.id === 'env.basic.must') return;
  if (mode === 'malformed' && v.id === 'env.basic.must') {
    process.stdout.write('not json\n');
    return;
  }
  if (mode === 'unsupported-must' && v.id === 'env.basic.must') {
    write({ dmp: 'unsupported', id: v.id, reason: 'not implemented' });
    return;
  }
  const failing =
    (mode === 'should-fail' && v.level === 'SHOULD') ||
    (mode === 'with-dispatch-fail' && v.id === 'a2a.basic.dispatch-must');
  const steps = failing
    ? [{ ok: false, error: { code: 'invalid' } }]
    : expected.get(v.id);
  write({
    dmp: 'observation',
    id: v.id,
    steps,
    messages: [],
    deliveries: [],
    calls: [],
    gateEffects: [],
    voided: [],
    channels: [],
    render: [],
  });
});
