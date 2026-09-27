import { isRecord, isText } from './guards.js';
import type { Deviation, TckAttestation } from './types.js';

// Requirements the kit has no vector for; only these may be declared as
// deviations from a Core or Dispatch-profile claim.
export const UNTESTED_SECTIONS = [
  '9.3',
  '13.1',
  '13.7',
  '13.8',
  '13.9',
  '13.10',
  '13.11',
  '13.16',
  'B.2',
] as const;

// The A2A deviations §8.10 declares; any other fails the A2A binding claim.
export const A2A_ALLOWED_DEVIATIONS = [
  'bounded-blocking-wait',
  'application-json',
] as const;

// A bad command line or input file: the bin exits 2.
export class UsageError extends Error {}

const TCK_LEVELS = ['must', 'should', 'may'] as const;
const TCK_RESULTS = ['pass', 'fail'] as const;

// Reads a `--deviations` file: a list of { section, summary } naming only
// requirements the kit does not test.
export function parseDeviations(raw: unknown): Deviation[] {
  if (!Array.isArray(raw))
    throw new UsageError('deviations must be a list of { section, summary }');
  const untested: readonly string[] = UNTESTED_SECTIONS;
  return raw.map((d: unknown, i) => {
    if (!isRecord(d) || !isText(d['section']) || !isText(d['summary']))
      throw new UsageError(`deviations[${i}] must be { section, summary }`);
    const section = d['section'];
    if (!untested.includes(section))
      throw new UsageError(
        `deviation §${section} is a tested requirement; only ${UNTESTED_SECTIONS.join(', ')} may be declared`
      );
    return { section, summary: d['summary'] };
  });
}

// Reads a `--tck-attest` file: the A2A TCK run the runner copies into the
// report, whose deviations must be ones §8.10 declares.
export function parseTckAttestation(raw: unknown): TckAttestation {
  if (!isRecord(raw))
    throw new UsageError(
      'a TCK attestation is { commit, transport, level, result, deviations }'
    );
  const { commit, transport, level, result, deviations } = raw;
  if (!Array.isArray(deviations) || !deviations.every(isText))
    throw new UsageError('attestation deviations must be a list of strings');
  const allowed: readonly string[] = A2A_ALLOWED_DEVIATIONS;
  const undeclared = deviations.find((d) => !allowed.includes(d));
  if (undeclared !== undefined)
    throw new UsageError(
      `A2A deviation ${undeclared} is not declared in §8.10`
    );
  if (!isText(commit)) throw new UsageError('attestation commit is required');
  if (!isText(transport))
    throw new UsageError('attestation transport is required');
  const levels: readonly unknown[] = TCK_LEVELS;
  if (!levels.includes(level))
    throw new UsageError(`attestation level must be ${TCK_LEVELS.join(', ')}`);
  const results: readonly unknown[] = TCK_RESULTS;
  if (!results.includes(result))
    throw new UsageError(
      `attestation result must be ${TCK_RESULTS.join(', ')}`
    );
  return {
    commit,
    transport,
    level: level as TckAttestation['level'],
    result: result as TckAttestation['result'],
    deviations,
  };
}
