import { LINE_BREAK } from './lines.js';
import { checkDigest, checkRender } from './renderCheck.js';
import { CREATING_OPS } from './types.js';
import type {
  CallRecord,
  Expectation,
  Hello,
  Json,
  JsonObject,
  Observation,
  ObservedMessage,
  Vector,
} from './types.js';

const CREATES: ReadonlySet<string> = new Set(CREATING_OPS);
const TOKEN = /\$(?:s|gate|notice)[0-9]+\b|\$system\b/g;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const DISPATCH_ID = /^[md]-[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const MAX_ID_BYTES = 64;
// Call fields that name a message; a call is judged only when one of them
// names a message the vector refers to.
const MESSAGE_FIELDS = ['message', 'question', 'answer'];

type Bound = Map<string, string>;

// Binds role symbols to the ids the observation produced (§12.4).
export function bindSymbols(
  vector: Vector,
  observation: Observation,
  hello: Hello
): Map<string, string> {
  const bound = new Map<string, string>([['$system', hello.systemAddress]]);
  const byStep = new Set<string>();
  vector.when.forEach((step, i) => {
    const r = observation.steps[i];
    if (!CREATES.has(step.op) || r === undefined || !r.ok) return;
    const id = (r.result as { message?: unknown } | undefined)?.message;
    if (typeof id !== 'string') return;
    bound.set(`$s${i + 1}`, id);
    byStep.add(id);
  });
  const seeded = seededIds(vector);
  let gates = 0;
  let notices = 0;
  for (const m of observation.messages) {
    if (byStep.has(m.id) || seeded.has(m.id) || m.from !== hello.systemAddress)
      continue;
    if (m.kind === 'question') {
      gates += 1;
      bound.set(`$gate${gates}`, m.id);
    } else if (m.kind === 'notice') {
      notices += 1;
      bound.set(`$notice${notices}`, m.id);
    }
  }
  return bound;
}

// Ids the vector's `given.store` seeds (messages and deliveries): literal,
// never symbols, and exempt from the increase and Dispatch-grammar rules.
function seededIds(vector: Vector): Set<string> {
  const store = vector.given.store;
  const rows = [...(store?.messages ?? []), ...(store?.deliveries ?? [])];
  return new Set(
    rows.flatMap((r) => (typeof r['id'] === 'string' ? [r['id']] : []))
  );
}

// The ids of the bound symbols the vector mentions anywhere, besides $system.
function namedIds(vector: Vector, bound: Bound): Set<string> {
  const named = new Set<string>();
  for (const [token] of JSON.stringify(vector).matchAll(TOKEN)) {
    const id = bound.get(token);
    if (token !== '$system' && id !== undefined) named.add(id);
  }
  return named;
}

function resolveText(text: string, bound: Bound): string {
  return text.replace(TOKEN, (t) => bound.get(t) ?? t);
}

// Replaces every bound symbol inside strings, deep.
function resolve(value: Json | undefined, bound: Bound): Json | undefined {
  if (typeof value === 'string') return resolveText(value, bound);
  if (Array.isArray(value)) return value.map((v) => resolve(v, bound) ?? null);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, bound) ?? null])
    );
  }
  return value;
}

// Writes bound ids back as their symbols, so failures read like the vector.
function symbolize(value: unknown, bound: Bound): string {
  let text = JSON.stringify(value) ?? 'undefined';
  for (const [symbol, id] of bound) {
    if (symbol !== '$system') text = text.replaceAll(id, symbol);
  }
  return text;
}

// Expected fields must match; fields the vector does not list are free.
function subset(
  expected: Json | undefined,
  actual: unknown,
  path: string,
  failures: string[]
): void {
  if (expected === undefined) return;
  if (
    expected !== null &&
    typeof expected === 'object' &&
    !Array.isArray(expected)
  ) {
    if (
      actual === null ||
      typeof actual !== 'object' ||
      Array.isArray(actual)
    ) {
      failures.push(
        `${path}: expected an object, got ${JSON.stringify(actual)}`
      );
      return;
    }
    for (const [k, v] of Object.entries(expected))
      subset(
        v,
        (actual as Record<string, unknown>)[k],
        `${path}.${k}`,
        failures
      );
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    failures.push(
      `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// Each listed step result: `ok` must match; an error compares its code, and
// its field when the vector names one; a result is matched as a subset.
function checkSteps(
  then: Expectation,
  observation: Observation,
  bound: Bound,
  failures: string[]
): void {
  (then.steps ?? []).forEach((expected, i) => {
    if (expected === null) return;
    const at = `step ${i + 1}`;
    const actual = observation.steps[i];
    if (actual === undefined) {
      failures.push(`${at}: no result`);
      return;
    }
    if (!expected.ok && !actual.ok) {
      if (actual.error.code !== expected.error.code)
        failures.push(
          `${at}: expected error ${expected.error.code}, got ${actual.error.code}`
        );
      if (
        expected.error.field !== undefined &&
        actual.error.field !== expected.error.field
      )
        failures.push(
          `${at}: expected error field ${expected.error.field}, got ${actual.error.field ?? 'none'}`
        );
      return;
    }
    if (expected.ok && actual.ok) {
      subset(
        resolve(expected.result, bound),
        actual.result,
        `${at}.result`,
        failures
      );
      return;
    }
    failures.push(
      actual.ok
        ? `${at}: expected an error, got ok`
        : `${at}: expected ok, got error ${actual.error.code}${actual.error.field === undefined ? '' : ` on ${actual.error.field}`}`
    );
  });
}

// The named messages exist once each, in order, with the listed fields; with
// noOtherMessages, anything else must be seeded or a system notice.
function checkMessages(
  vector: Vector,
  observation: Observation,
  bound: Bound,
  hello: Hello,
  failures: string[]
): void {
  const then = vector.then;
  const ids = observation.messages.map((m) => m.id);
  const listed = new Set<string>();
  let last = -1;
  for (const expected of then.messages ?? []) {
    const symbol =
      typeof expected['id'] === 'string'
        ? expected['id']
        : JSON.stringify(expected['id'] ?? null);
    const id = resolve(expected['id'], bound);
    const index = typeof id === 'string' ? ids.indexOf(id) : -1;
    if (index === -1) {
      failures.push(`message ${symbol} was not created`);
      continue;
    }
    const found = ids[index] ?? '';
    if (listed.has(found)) {
      failures.push(`message ${symbol} is listed twice`);
      continue;
    }
    listed.add(found);
    if (index < last) failures.push(`message ${symbol} is out of order`);
    last = index;
    const actual = observation.messages[index] as unknown as Record<
      string,
      unknown
    >;
    for (const [k, v] of Object.entries(expected)) {
      if (k !== 'id')
        subset(
          resolve(v, bound),
          actual[k],
          `message ${symbol}.${k}`,
          failures
        );
    }
  }
  if (then.noOtherMessages !== true) return;
  const named = namedIds(vector, bound);
  const seeded = seededIds(vector);
  for (const m of observation.messages) {
    if (listed.has(m.id) || named.has(m.id) || seeded.has(m.id)) continue;
    if (m.from === hello.systemAddress && m.kind === 'notice') continue;
    failures.push(`unexpected message ${m.id} (${m.kind} from ${m.from})`);
  }
}

// For each message the list mentions, its deliveries are exactly the listed
// recipients, with via, state and session compared when listed; each message
// `noDeliveries` lists exists and has none.
function checkDeliveries(
  then: Expectation,
  observation: Observation,
  bound: Bound,
  failures: string[]
): void {
  const groups = new Map<string, { symbol: string; recipients: Set<string> }>();
  for (const row of then.deliveries ?? []) {
    const id = resolveText(row.message, bound);
    const recipient = resolveText(row.recipient, bound);
    const group = groups.get(id) ?? {
      symbol: row.message,
      recipients: new Set(),
    };
    group.recipients.add(recipient);
    groups.set(id, group);
    const at = `delivery of ${row.message} to ${recipient}`;
    const found = observation.deliveries.filter(
      (d) => d.message === id && d.recipient === recipient
    );
    const match = found[0];
    if (match === undefined) {
      failures.push(`${at} does not exist`);
      continue;
    }
    if (found.length > 1) failures.push(`${at} exists ${found.length} times`);
    for (const key of ['via', 'state', 'session'] as const) {
      if (row[key] !== undefined && row[key] !== match[key])
        failures.push(
          `${at}: ${key} expected ${JSON.stringify(row[key])}, got ${JSON.stringify(match[key])}`
        );
    }
  }
  for (const [id, { symbol, recipients }] of groups) {
    for (const d of observation.deliveries) {
      if (d.message === id && !recipients.has(d.recipient))
        failures.push(`unexpected delivery of ${symbol} to ${d.recipient}`);
    }
  }
  for (const symbol of then.noDeliveries ?? []) {
    const id = resolveText(symbol, bound);
    if (!observation.messages.some((m) => m.id === id))
      failures.push(`${symbol} names no message`);
    else if (observation.deliveries.some((d) => d.message === id))
      failures.push(`${symbol} has deliveries`);
  }
}

// Hook calls that reference a named or seeded message: `calls` exactly, in
// order; `callsInclude` as an ordered subsequence.
function checkCalls(
  vector: Vector,
  observation: Observation,
  bound: Bound,
  failures: string[]
): void {
  const { calls, callsInclude } = vector.then;
  if (calls === undefined && callsInclude === undefined) return;
  const named = new Set([...namedIds(vector, bound), ...seededIds(vector)]);
  const relevant = observation.calls.filter((c) =>
    MESSAGE_FIELDS.some((k) => {
      const v = c[k];
      return typeof v === 'string' && named.has(v);
    })
  );
  const matches = (expected: JsonObject, actual: CallRecord): boolean => {
    const f: string[] = [];
    subset(resolve(expected, bound), actual, 'call', f);
    return f.length === 0;
  };
  const got = symbolize(relevant, bound);
  if (calls !== undefined) {
    const same =
      calls.length === relevant.length &&
      calls.every((e, i) => {
        const actual = relevant[i];
        return actual !== undefined && matches(e, actual);
      });
    if (!same)
      failures.push(`calls: expected ${JSON.stringify(calls)}, got ${got}`);
  }
  if (callsInclude !== undefined) {
    let next = 0;
    for (const c of relevant) {
      const want = callsInclude[next];
      if (want !== undefined && matches(want, c)) next += 1;
    }
    const missing = callsInclude[next];
    if (missing !== undefined)
      failures.push(
        `calls: ${JSON.stringify(missing)} is not in order in ${got}`
      );
  }
}

// Compares two lists as sets; the failure names what is missing and extra.
function setFailure(
  name: string,
  want: readonly string[],
  got: readonly string[],
  show: (items: string[]) => string
): string | null {
  const w = new Set(want);
  const g = new Set(got);
  const missing = [...w].filter((x) => !g.has(x));
  const extra = [...g].filter((x) => !w.has(x));
  if (missing.length === 0 && extra.length === 0) return null;
  return `${name}: missing ${show(missing)}, unexpected ${show(extra)}`;
}

// Resolved expected ids equal the observed ids, as sets.
function checkSets(
  name: string,
  expected: string[] | undefined,
  actual: string[],
  bound: Bound,
  failures: string[]
): void {
  if (expected === undefined) return;
  const want = expected.map((e) => resolveText(e, bound));
  const failure = setFailure(name, want, actual, (xs) => symbolize(xs, bound));
  if (failure !== null) failures.push(failure);
}

// Channels and their members, compared as sets.
function checkChannels(
  then: Expectation,
  observation: Observation,
  bound: Bound,
  failures: string[]
): void {
  if (then.channels === undefined) return;
  const key = (c: { name: string; members: string[] }): string =>
    JSON.stringify([
      resolveText(c.name, bound),
      c.members.map((m) => resolveText(m, bound)).sort(),
    ]);
  const failure = setFailure(
    'channels',
    then.channels.map(key),
    observation.channels.map(key),
    (xs) => `[${xs.join(', ')}]`
  );
  if (failure !== null) failures.push(failure);
}

// What a message's sender wrote besides its body, plus the lines of the
// message it replies to: text an external sender's host lines must not carry.
function senderText(
  message: ObservedMessage,
  observation: Observation
): string[] {
  const refText = message.refs.flatMap((r) =>
    [r['id'], r['at']].filter((v): v is string => typeof v === 'string')
  );
  const target = observation.messages.find((m) => m.id === message.replyTo);
  return [
    ...(message.choices ?? []),
    ...(message.choice === undefined ? [] : [message.choice]),
    ...refText,
    ...(target === undefined ? [] : target.body.split(LINE_BREAK)),
  ];
}

// Each `render` step not expected to fail must fit the declared forms, or the
// digest rule for a digest, and match `then.render`'s text where it names it.
function checkRenders(
  vector: Vector,
  observation: Observation,
  bound: Bound,
  hello: Hello,
  failures: string[]
): void {
  const textOf = (step: number): string | undefined =>
    observation.render.find((r) => r.step === step)?.text;
  vector.when.forEach((step, i) => {
    if (step.op !== 'render') return;
    const n = i + 1;
    if (vector.then.steps?.[i]?.ok === false) return;
    const text = textOf(n);
    if (text === undefined) {
      failures.push(`step ${n}: no rendered text`);
      return;
    }
    if (vector.profile !== 'core') return;
    const target = step['message'];
    const id = typeof target === 'string' ? resolveText(target, bound) : '';
    const message = observation.messages.find((m) => m.id === id);
    if (message === undefined) {
      failures.push(
        `step ${n}: the rendered message ${JSON.stringify(target) ?? 'nothing'} was not observed`
      );
      return;
    }
    const found =
      step['form'] === 'digest'
        ? checkDigest(text, message.body, hello.render)
        : checkRender(
            text,
            message.body,
            hello.render,
            step['external'] === true,
            senderText(message, observation)
          );
    for (const f of found) failures.push(`step ${n}: ${f}`);
  });
  for (const r of vector.then.render ?? []) {
    const want = resolveText(r.text, bound);
    const text = textOf(r.step);
    if (text !== want)
      failures.push(
        `step ${r.step}: rendered ${JSON.stringify(text) ?? 'nothing'}, expected ${JSON.stringify(want)}`
      );
  }
}

// Byte order of two ids' UTF-8 encodings.
function bytewiseBefore(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return x.length < y.length;
}

// Always checked: ids are unique identifiers of at most 64 bytes; generated
// message ids increase bytewise; the Dispatch profile narrows their grammar.
function checkIds(
  vector: Vector,
  observation: Observation,
  failures: string[]
): void {
  const seeded = seededIds(vector);
  const dispatch = vector.profile === 'dispatch';
  const check = (kind: 'message' | 'delivery', ids: string[]): void => {
    const prefix = kind === 'message' ? 'm-' : 'd-';
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) failures.push(`${kind} id ${id} is not unique`);
      seen.add(id);
      if (
        !IDENTIFIER.test(id) ||
        new TextEncoder().encode(id).length > MAX_ID_BYTES
      )
        failures.push(
          `${kind} id ${JSON.stringify(id)} is not an identifier of at most ${MAX_ID_BYTES} bytes`
        );
      else if (
        dispatch &&
        !seeded.has(id) &&
        !(DISPATCH_ID.test(id) && id.startsWith(prefix))
      )
        failures.push(
          `${kind} id ${id} is outside the Dispatch m-/d- grammar (${prefix} plus 26 lowercase Crockford characters)`
        );
    }
  };
  check(
    'message',
    observation.messages.map((m) => m.id)
  );
  check(
    'delivery',
    observation.deliveries.map((d) => d.id)
  );
  let previous: string | null = null;
  for (const m of observation.messages) {
    if (seeded.has(m.id)) continue;
    if (previous !== null && !bytewiseBefore(previous, m.id))
      failures.push(`message ids do not increase: ${m.id} follows ${previous}`);
    previous = m.id;
  }
}

// Judges an observation against the vector's expectation (§12.4).
export function compare(
  vector: Vector,
  observation: Observation,
  hello: Hello
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const bound = bindSymbols(vector, observation, hello);
  const then = vector.then;
  checkSteps(then, observation, bound, failures);
  checkMessages(vector, observation, bound, hello, failures);
  checkDeliveries(then, observation, bound, failures);
  checkCalls(vector, observation, bound, failures);
  checkSets(
    'gateEffects',
    then.gateEffects,
    observation.gateEffects,
    bound,
    failures
  );
  checkSets('voided', then.voided, observation.voided, bound, failures);
  checkChannels(then, observation, bound, failures);
  checkRenders(vector, observation, bound, hello, failures);
  checkIds(vector, observation, failures);
  return { ok: failures.length === 0, failures };
}
