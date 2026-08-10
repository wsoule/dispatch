import { describe, expect, test } from 'bun:test';

import { summarizeChecks } from '../src/orchestrator/pr';

describe('summarizeChecks', () => {
  test('preserves per-check name, conclusion, and url', () => {
    const rollup = [
      {
        name: 'build',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/x/y/runs/1',
      },
      {
        name: 'test',
        status: 'IN_PROGRESS',
        conclusion: null,
        detailsUrl: 'https://github.com/x/y/runs/2',
      },
      {
        context: 'legacy-ci',
        state: 'FAILURE',
        targetUrl: 'https://ci.example/3',
      },
    ];
    const summary = summarizeChecks(rollup);
    expect(summary).toMatchObject({
      passed: 1,
      failed: 1,
      pending: 1,
      total: 3,
    });
    expect(summary.runs).toEqual([
      {
        name: 'build',
        conclusion: 'SUCCESS',
        url: 'https://github.com/x/y/runs/1',
      },
      {
        name: 'test',
        conclusion: 'PENDING',
        url: 'https://github.com/x/y/runs/2',
      },
      { name: 'legacy-ci', conclusion: 'FAILURE', url: 'https://ci.example/3' },
    ]);
  });

  test('non-array rollup yields empty runs', () => {
    expect(summarizeChecks(undefined).runs).toEqual([]);
  });
});
