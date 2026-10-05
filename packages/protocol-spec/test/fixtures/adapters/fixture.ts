// A scripted adapter answering from each vector's own `then`, bent by the mode
// in argv[2]; argv[3] is that mode's state file, start log or patch JSON.
import {
  appendFileSync,
  closeSync,
  existsSync,
  readdirSync,
  readFileSync,
  readSync,
} from 'node:fs';

const mode = process.argv[2] ?? 'pass';
const arg = process.argv[3] ?? '';
const withDispatch = mode.startsWith('with-dispatch');
// A Dispatch-profile adapter declares every gate type the live registry makes
// permanent, as the dispatch-profile claim requires.
const permanentGateTypes = (
  JSON.parse(
    readFileSync(
      new URL('../../../registries/registries.json', import.meta.url),
      'utf8'
    )
  ) as { 'gate-types': { value: string; status: string }[] }
)['gate-types']
  .filter((g) => g.status === 'permanent')
  .map((g) => g.value);
const hello = {
  dmp: 'hello',
  implementation: { name: 'fixture', version: '0.0.0' },
  classes: ['envelope', 'host-core', 'a2a-binding'],
  profiles: withDispatch ? ['core', 'dispatch'] : ['core'],
  capabilities: mode === 'with-cap' ? ['x-cap'] : [],
  systemAddress: 'agent:system',
  gateTypes: withDispatch
    ? [...new Set(['wake', ...permanentGateTypes])]
    : ['wake'],
  render: {
    quotePrefix: '> ',
    header: '^\\[from ',
    hostLines: [],
    digestLead: '^\\(from [^)]*\\) ',
  },
  ...(mode === 'patch-hello' ? (JSON.parse(arg) as object) : {}),
};
// What the runner resolves before the pipe, so the adapter never sees it.
const RUNNER_SYMBOL = /\$(?:system|unimplementedGateType)\b/;
// The runner escapes these, so a reader that breaks lines at them still works.
const RAW_SEPARATOR = /[\u2028\u2029]/;
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
// Writes U+2028 and U+2029 raw, which the runner must read inside one line.
const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

function onLine(line: string): void {
  const msg = JSON.parse(line) as {
    dmp: string;
    vector?: {
      id: string;
      level: string;
      when: { input?: unknown }[];
      then?: unknown;
    };
  };
  if (msg.dmp === 'hello') {
    if (mode === 'crash-always' && arg !== '') appendFileSync(arg, 'started\n');
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
  if (mode === 'crash-once' && !existsSync(arg)) {
    appendFileSync(arg, 'crashed');
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
  // An expectation, a runner symbol or a raw separator on the pipe fails the
  // vector loudly.
  const leak = RAW_SEPARATOR.test(line)
    ? 'unescaped-separator'
    : 'then' in v
      ? 'saw-then'
      : RUNNER_SYMBOL.test(JSON.stringify(v))
        ? 'unresolved-symbol'
        : null;
  const steps =
    leak !== null
      ? [{ ok: false, error: { code: leak } }]
      : failing
        ? [{ ok: false, error: { code: 'invalid' } }]
        : mode === 'echo'
          ? v.when.map((s) => ({ ok: true, result: s.input }))
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
    ...(mode === 'patch-observation' ? (JSON.parse(arg) as object) : {}),
  });
}

if (mode === 'close-stdin-after-hello') {
  // Waits for hello, closes fd 0 and answers, then stays up, so
  // the runner's next write fails with EPIPE every time.
  readSync(0, Buffer.alloc(4096));
  closeSync(0);
  write(hello);
  setTimeout(() => process.exit(0), 300);
} else {
  // Splits stdin at LF alone, as the contract asks of an adapter.
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
}
