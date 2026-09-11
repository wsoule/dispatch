import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  missingWorkerEntries,
  parseSidecars,
  workerModulesIn,
} from './check-worker-entries';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildSidecarsText = readFileSync(
  resolve(repoRoot, 'apps/desktop/scripts/build-sidecars.ts'),
  'utf8'
);
const watchdogText = readFileSync(
  resolve(repoRoot, 'packages/server/src/watchdog.ts'),
  'utf8'
);

const serverFiles = [
  { path: 'packages/server/src/watchdog.ts', text: watchdogText },
];

test('derives the watchdog worker from the server source, not a hard-coded name', () => {
  expect(workerModulesIn(serverFiles)).toEqual([
    'packages/server/src/watchdogWorker.ts',
  ]);
});

test('ignores an import.meta.url URL in a file that spawns no Worker', () => {
  expect(
    workerModulesIn([
      {
        path: 'packages/server/src/index.ts',
        text: "const dist = new URL('./web/dist', import.meta.url);",
      },
    ])
  ).toEqual([]);
});

test('parses every sidecar and the server one carries the worker entry', () => {
  const sidecars = parseSidecars(buildSidecarsText);
  expect(sidecars.map((s) => s.entry)).toEqual([
    'packages/server/src/bin.ts',
    'packages/mcp/src/bin.ts',
    'packages/cli/src/cli.ts',
  ]);
  expect(sidecars[0].extraEntries).toEqual([
    'packages/server/src/watchdogWorker.ts',
  ]);
});

test('the real build-sidecars.ts passes against the real server source', () => {
  const sidecars = parseSidecars(buildSidecarsText);
  expect(missingWorkerEntries(sidecars, workerModulesIn(serverFiles))).toEqual(
    []
  );
});

// Mutation 1: someone deletes the extraEntries line.
test('fails when the worker entry is removed from build-sidecars.ts', () => {
  const mutated = buildSidecarsText.replace(
    /\s*extraEntries: \[[\s\S]*?\],/,
    ''
  );
  expect(mutated).not.toBe(buildSidecarsText);
  const sidecars = parseSidecars(mutated);
  expect(sidecars[0].extraEntries).toEqual([]);
  expect(missingWorkerEntries(sidecars, workerModulesIn(serverFiles))).toEqual([
    {
      sidecar: 'packages/server/src/bin.ts',
      worker: 'packages/server/src/watchdogWorker.ts',
    },
  ]);
});

// Mutation 2: a second Worker appears in the server without a matching entry.
test('fails when a new Worker is spawned without a compile entry', () => {
  const files = [
    ...serverFiles,
    {
      path: 'packages/server/src/indexer/index.ts',
      text: "const w = new Worker(new URL('./indexWorker.js', import.meta.url));",
    },
  ];
  expect(workerModulesIn(files)).toEqual([
    'packages/server/src/indexer/indexWorker.ts',
    'packages/server/src/watchdogWorker.ts',
  ]);
  expect(
    missingWorkerEntries(
      parseSidecars(buildSidecarsText),
      workerModulesIn(files)
    )
  ).toEqual([
    {
      sidecar: 'packages/server/src/bin.ts',
      worker: 'packages/server/src/indexer/indexWorker.ts',
    },
  ]);
});

test('a worker outside a sidecar source tree is not that sidecar’s problem', () => {
  const files = [
    {
      path: 'apps/desktop/src/pool.ts',
      text: "new Worker(new URL('./poolWorker.ts', import.meta.url))",
    },
  ];
  expect(
    missingWorkerEntries(
      parseSidecars(buildSidecarsText),
      workerModulesIn(files)
    )
  ).toEqual([]);
});
