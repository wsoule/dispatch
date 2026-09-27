#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  parseDeviations,
  parseTckAttestation,
  UsageError,
} from './deviations.js';
import { toJUnit } from './junit.js';
import { runConformance } from './runner.js';
import { CLAIMS } from './types.js';
import type { ClaimName } from './types.js';

const USAGE =
  'dmp-conformance --adapter "<command>" [--claim core|envelope|dispatch-profile|a2a-binding]… [--vectors <dir>] [--report <file>] [--junit <file>] [--tck-attest <file>] [--deviations <file>] [--vectors-only] [--timeout-ms 10000]';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Node clamps a setTimeout delay above 2^31 - 1 ms to 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS)
    throw new UsageError(
      `--timeout-ms must be a positive integer up to ${MAX_TIMEOUT_MS}\n${USAGE}`
    );
  return ms;
}

// node:util's parseArgs reports an unknown or malformed flag as a TypeError
// whose code starts with ERR_PARSE_ARGS.
function isParseArgsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      adapter: { type: 'string' },
      claim: { type: 'string', multiple: true },
      vectors: { type: 'string' },
      report: { type: 'string' },
      junit: { type: 'string' },
      'tck-attest': { type: 'string' },
      deviations: { type: 'string' },
      'vectors-only': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
    },
  });
  const adapter = values.adapter;
  if (adapter === undefined || adapter === '')
    throw new UsageError(`--adapter is required\n${USAGE}`);
  const claims = (values.claim ?? ['core']).map((c) => {
    if (!(CLAIMS as readonly string[]).includes(c))
      throw new UsageError(`unknown claim ${c}\n${USAGE}`);
    return c as ClaimName;
  });
  const tck = values['tck-attest'];
  const deviations = values.deviations;
  const report = await runConformance({
    adapter,
    claims,
    vectorsDir: values.vectors,
    timeoutMs: parseTimeout(values['timeout-ms']),
    tckAttest:
      tck === undefined ? undefined : parseTckAttestation(readJson(tck)),
    deviations:
      deviations === undefined
        ? undefined
        : parseDeviations(readJson(deviations)),
    vectorsOnly: values['vectors-only'] === true,
    log: (line) => process.stderr.write(line),
  });
  writeFileSync(
    values.report ?? 'dmp-conformance.json',
    `${JSON.stringify(report, null, 2)}\n`
  );
  if (values.junit !== undefined) writeFileSync(values.junit, toJUnit(report));
  for (const [claim, result] of Object.entries(report.claims))
    process.stdout.write(`${claim}: ${result}\n`);
  return Object.values(report.claims).includes('fail') ? 1 : 0;
}

// Exits once the stream has flushed, so a piped stdout or stderr keeps its
// last lines.
function exitAfter(stream: NodeJS.WriteStream, code: number): void {
  stream.write('', () => process.exit(code));
}

main().then(
  (code) => exitAfter(process.stdout, code),
  (err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`
    );
    exitAfter(
      process.stderr,
      err instanceof UsageError || isParseArgsError(err) ? 2 : 1
    );
  }
);
