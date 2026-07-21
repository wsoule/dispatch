import { describe, expect, it } from 'bun:test';

import type { ApiClient, PlanRecord } from '../src/apiClient.js';
import { pollUntilSettled } from '../src/commands/plan.js';
import { CliError } from '../src/context.js';

function makeClient(getPlan: ApiClient['getPlan']): ApiClient {
  return {
    baseUrl: '',
    createRun: () => Promise.reject(new Error('not used')),
    listRuns: () => Promise.reject(new Error('not used')),
    getRun: () => Promise.reject(new Error('not used')),
    approveRun: () => Promise.reject(new Error('not used')),
    sendRunMessage: () => Promise.reject(new Error('not used')),
    cancelRun: () => Promise.reject(new Error('not used')),
    getRunDiff: () => Promise.reject(new Error('not used')),
    reviewRun: () => Promise.reject(new Error('not used')),
    startPlan: () => Promise.reject(new Error('not used')),
    getPlan,
    confirmPlan: () => Promise.reject(new Error('not used')),
    startEpic: () => Promise.reject(new Error('not used')),
    stopEpic: () => Promise.reject(new Error('not used')),
    getEpicProgress: () => Promise.reject(new Error('not used')),
  };
}

function makeRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-1',
    prompt: 'do something',
    state: 'running',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('pollUntilSettled', () => {
  it('returns as soon as the plan leaves running', async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls++;
      return Promise.resolve(
        makeRecord({ state: calls < 2 ? 'running' : 'ready' })
      );
    });
    const record = await pollUntilSettled(client, 'plan-1', 5000);
    expect(record.state).toBe('ready');
  });

  // M6: a plan that never settles must throw a message pointing the user
  // at `dispatch plan show <plan-id>` to check back later, not a bare
  // "did not settle" dead end.
  it('throws a CliError pointing at `dispatch plan show <plan-id>` once the timeout elapses', async () => {
    const client = makeClient(() => Promise.resolve(makeRecord()));
    await expect(pollUntilSettled(client, 'plan-abc123', 100)).rejects.toThrow(
      CliError
    );
    await expect(pollUntilSettled(client, 'plan-abc123', 100)).rejects.toThrow(
      /dispatch plan show plan-abc123/
    );
  });
});
