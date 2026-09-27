import { AdapterError, AdapterProcess } from './adapterProcess.js';
import { compare } from './compare.js';
import { loadVectors } from './load.js';
import { prepareVector, stripThen } from './prepare.js';
import { loadRegistry } from './registries.js';
import type { Registry } from './registries.js';
import { VECTOR_CLASSES } from './types.js';
import type {
  ClaimName,
  ClassTally,
  Deviation,
  Hello,
  Profile,
  Report,
  TckAttestation,
  Vector,
  VectorClass,
  VectorResult,
} from './types.js';
import { KIT_NAME, KIT_VERSION } from './version.js';

export interface RunOptions {
  adapter: string;
  claims: ClaimName[];
  vectorsDir?: URL | string;
  timeoutMs?: number;
  tckAttest?: TckAttestation;
  deviations?: Deviation[];
  vectorsOnly?: boolean;
  log?: (line: string) => void;
}

const CLAIM_CLASSES: Record<ClaimName, readonly VectorClass[]> = {
  envelope: ['envelope'],
  core: ['envelope', 'host-core'],
  'dispatch-profile': ['envelope', 'host-core'],
  'a2a-binding': ['envelope', 'host-core', 'a2a-binding'],
};
const CLAIM_PROFILES: Record<ClaimName, readonly Profile[]> = {
  envelope: ['core'],
  core: ['core'],
  'dispatch-profile': ['core', 'dispatch'],
  'a2a-binding': ['core'],
};
const MAX_RESTARTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

// The profiles a claim judges. A Dispatch-profile A2A claim is the union: next
// to dispatch-profile, the A2A claim also judges dispatch-profile vectors.
function profilesFor(
  claim: ClaimName,
  claims: readonly ClaimName[]
): readonly Profile[] {
  if (claim === 'a2a-binding' && claims.includes('dispatch-profile'))
    return ['core', 'dispatch'];
  return CLAIM_PROFILES[claim];
}

// Why a vector is skipped before it runs, or null when it runs.
function skipReason(v: Vector, hello: Hello): string | null {
  if (!hello.classes.includes(v.class) || !hello.profiles.includes(v.profile))
    return 'class or profile not declared';
  if (
    v.level === 'MAY' &&
    v.capability !== undefined &&
    !hello.capabilities.includes(v.capability)
  )
    return `capability ${v.capability} not declared`;
  return null;
}

function tally(results: readonly VectorResult[]): ClassTally {
  const count = (keep: (r: VectorResult) => boolean): number =>
    results.filter(keep).length;
  return {
    pass: count((r) => r.outcome === 'pass'),
    fail: count((r) => r.outcome === 'fail' || r.outcome === 'adapter-error'),
    skipped: count((r) => r.outcome === 'skipped'),
    notApplicable: count((r) => r.outcome === 'not-applicable'),
    shouldFailures: count((r) => r.level === 'SHOULD' && r.outcome === 'fail'),
  };
}

// A claim fails when a class it needs has no vector that ran, when a MUST
// did not pass, or when its extra requirement (gate types, the TCK) is unmet.
export function claimOutcome(
  claim: ClaimName,
  results: readonly VectorResult[],
  hello: Hello,
  registry: Registry,
  opts: RunOptions
): 'pass' | 'fail' | 'vectors-only' {
  const profiles = profilesFor(claim, opts.claims);
  const mine = results.filter(
    (r) =>
      CLAIM_CLASSES[claim].includes(r.class) && profiles.includes(r.profile)
  );
  for (const c of CLAIM_CLASSES[claim]) {
    if (
      !mine.some(
        (r) => r.class === c && (r.outcome === 'pass' || r.outcome === 'fail')
      )
    )
      return 'fail';
  }
  if (
    mine.some(
      (r) =>
        r.level === 'MUST' &&
        r.outcome !== 'pass' &&
        r.outcome !== 'not-applicable'
    )
  )
    return 'fail';
  if (claim === 'dispatch-profile') {
    const needed = registry['gate-types']
      .filter((g) => g.status === 'permanent')
      .map((g) => g.value);
    if (!needed.every((t) => hello.gateTypes.includes(t))) return 'fail';
  }
  if (claim === 'a2a-binding') {
    if (opts.tckAttest !== undefined)
      return opts.tckAttest.result === 'pass' ? 'pass' : 'fail';
    return opts.vectorsOnly === true ? 'vectors-only' : 'fail';
  }
  return 'pass';
}

function buildReport(
  opts: RunOptions,
  hello: Hello,
  registry: Registry,
  results: VectorResult[]
): Report {
  const claimed = new Set(opts.claims.flatMap((c) => CLAIM_CLASSES[c]));
  const classes: Report['classes'] = {};
  for (const c of VECTOR_CLASSES) {
    if (claimed.has(c))
      classes[c] = tally(results.filter((r) => r.class === c));
  }
  const claims: Report['claims'] = {};
  for (const claim of opts.claims)
    claims[claim] = claimOutcome(claim, results, hello, registry, opts);
  const attest = opts.tckAttest;
  const a2a: Report['a2a'] = opts.claims.includes('a2a-binding')
    ? {
        tck:
          attest === undefined
            ? null
            : {
                commit: attest.commit,
                transport: attest.transport,
                level: attest.level,
                result: attest.result,
                attested: true,
              },
        deviations: attest?.deviations ?? [],
      }
    : undefined;
  return {
    dmp: KIT_VERSION,
    kit: KIT_VERSION,
    implementation: {
      name: hello.implementation.name,
      version: hello.implementation.version,
    },
    claims,
    classes,
    vectors: results,
    declaredDeviations: opts.deviations ?? [],
    ...(a2a === undefined ? {} : { a2a }),
    runner: `${KIT_NAME}@${KIT_VERSION}`,
    date: new Date().toISOString(),
  };
}

// Starts an adapter and waits for its hello, killing it if the hello fails.
async function startAdapter(
  command: string,
  log: (line: string) => void
): Promise<{ adapter: AdapterProcess; hello: Hello }> {
  const adapter = new AdapterProcess(command, log);
  try {
    return { adapter, hello: await adapter.start(KIT_VERSION) };
  } catch (err) {
    adapter.kill();
    throw err;
  }
}

// Runs every vector the requested claims need through one adapter and judges
// each claim by the TCK's levels (spec:888-912).
export async function runConformance(opts: RunOptions): Promise<Report> {
  const log = opts.log ?? ((): void => undefined);
  const registry = loadRegistry();
  const classes = new Set(opts.claims.flatMap((c) => CLAIM_CLASSES[c]));
  const profiles = new Set(
    opts.claims.flatMap((c) => profilesFor(c, opts.claims))
  );
  const scope = loadVectors(opts.vectorsDir).vectors.filter(
    (v) => classes.has(v.class) && profiles.has(v.profile)
  );
  const started = await startAdapter(opts.adapter, log);
  const hello = started.hello;
  let adapter = started.adapter;
  let restarts = 0;
  const results: VectorResult[] = [];
  for (const v of scope) {
    const base = {
      id: v.id,
      class: v.class,
      level: v.level,
      profile: v.profile,
    };
    const skip = skipReason(v, hello);
    if (skip !== null) {
      results.push({ ...base, outcome: 'skipped', reasons: [skip] });
      continue;
    }
    const prepared = prepareVector(v, hello, registry);
    if (prepared.notApplicable) {
      results.push({
        ...base,
        outcome: 'not-applicable',
        reasons: ['every registered gate type is implemented'],
      });
      continue;
    }
    if (restarts > MAX_RESTARTS) {
      results.push({
        ...base,
        outcome: 'adapter-error',
        reasons: [`the adapter was restarted ${MAX_RESTARTS} times`],
      });
      continue;
    }
    try {
      const reply = await adapter.run(
        stripThen(prepared.vector),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );
      if (reply.dmp === 'unsupported') {
        results.push({
          ...base,
          outcome: 'skipped',
          reasons: [`unsupported: ${reply.reason}`],
        });
        continue;
      }
      const { failures } = compare(prepared.vector, reply, hello);
      results.push({
        ...base,
        outcome: failures.length === 0 ? 'pass' : 'fail',
        reasons: failures,
      });
    } catch (err) {
      if (!(err instanceof AdapterError)) throw err;
      results.push({
        ...base,
        outcome: 'adapter-error',
        reasons: [err.message],
      });
      adapter.kill();
      restarts += 1;
      if (restarts <= MAX_RESTARTS) {
        try {
          adapter = (await startAdapter(opts.adapter, log)).adapter;
        } catch {
          restarts = MAX_RESTARTS + 1;
        }
      }
    }
  }
  await adapter.stop();
  return buildReport(opts, hello, registry, results);
}
