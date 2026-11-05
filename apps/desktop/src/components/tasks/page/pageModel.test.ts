import type { RunMeta } from '@dispatch/client';
import { expect, test } from 'bun:test';

import { run, task } from './pageHost.test-helper';
import { fixLoopTaskId, verificationTaskId } from './pageModel';

// Review and Summary read a task's verify result and fix loop only once they can exist,
// so a task without them costs no 404 (each one a console error in the browser).

const item = task('t-1');

function page(allRuns: RunMeta[]) {
  return {
    item,
    allRuns,
    runs: allRuns.filter((r) => (r.kind ?? 'execute') === 'execute'),
  };
}

test('no verify read for a task without a finished verify run', () => {
  expect(verificationTaskId(page([]))).toBeUndefined();
  expect(
    verificationTaskId(page([run({ state: 'finished' })]))
  ).toBeUndefined();
  expect(
    verificationTaskId(page([run({ id: 'r-v', kind: 'verify' })]))
  ).toBeUndefined();
});

test('a verify run that has ended turns the verify read on', () => {
  expect(
    verificationTaskId(
      page([run({ id: 'r-v', kind: 'verify', state: 'failed' })])
    )
  ).toBe('t-1');
  expect(
    verificationTaskId(
      page([
        run({ id: 'r-v2', kind: 'verify' }),
        run({ id: 'r-v1', kind: 'verify', state: 'finished' }),
      ])
    )
  ).toBe('t-1');
});

test('no fix-loop read before the task has an execute run', () => {
  expect(fixLoopTaskId(page([]))).toBeUndefined();
  expect(
    fixLoopTaskId(page([run({ kind: 'verify', state: 'finished' })]))
  ).toBeUndefined();
  expect(fixLoopTaskId(page([run()]))).toBe('t-1');
});
