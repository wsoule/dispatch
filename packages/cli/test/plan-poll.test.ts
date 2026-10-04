import { describe, expect, it } from 'bun:test';

import type { ApiClient, PlanRecord } from '../src/apiClient.js';
import { pollUntilSettled } from '../src/commands/plan.js';
import { CliError } from '../src/context.js';

function makeClient(getPlan: ApiClient['getPlan']): ApiClient {
  return {
    baseUrl: '',
    createRun: () => Promise.reject(new Error('not used')),
    resumeRun: () => Promise.reject(new Error('not used')),
    listRuns: () => Promise.reject(new Error('not used')),
    getRun: () => Promise.reject(new Error('not used')),
    cancelRun: () => Promise.reject(new Error('not used')),
    getRunDiff: () => Promise.reject(new Error('not used')),
    reviewRun: () => Promise.reject(new Error('not used')),
    startPlan: () => Promise.reject(new Error('not used')),
    getPlan,
    sendPlanMessage: () => Promise.reject(new Error('not used')),
    confirmPlan: () => Promise.reject(new Error('not used')),
    startEpic: () => Promise.reject(new Error('not used')),
    pauseEpic: () => Promise.reject(new Error('not used')),
    resumeEpic: () => Promise.reject(new Error('not used')),
    fetchExecutors: () => Promise.resolve({ executors: [], default: 'claude' }),
    stopEpic: () => Promise.reject(new Error('not used')),
    getEpicProgress: () => Promise.reject(new Error('not used')),
    openDecisions: () => Promise.reject(new Error('not used')),
    getMessage: () => Promise.reject(new Error('not used')),
    getAnswer: () => Promise.reject(new Error('not used')),
    replyToMessage: () => Promise.reject(new Error('not used')),
    sendMessage: () => Promise.reject(new Error('not used')),
    getMailbox: () => Promise.reject(new Error('not used')),
    fanoutTask: () => Promise.reject(new Error('not used')),
    launchBrowser: () => Promise.reject(new Error('not used')),
    listBrowsers: () => Promise.reject(new Error('not used')),
    closeBrowser: () => Promise.reject(new Error('not used')),
    navigateBrowser: () => Promise.reject(new Error('not used')),
    browserClick: () => Promise.reject(new Error('not used')),
    browserFill: () => Promise.reject(new Error('not used')),
    browserText: () => Promise.reject(new Error('not used')),
    browserEvaluate: () => Promise.reject(new Error('not used')),
    browserScreenshot: () => Promise.reject(new Error('not used')),
    browserStartPick: () => Promise.reject(new Error('not used')),
    browserPickResult: () => Promise.reject(new Error('not used')),
    getTaskFindings: () => Promise.reject(new Error('not used')),
    getLedger: () => Promise.reject(new Error('not used')),
    issueTeamToken: () => Promise.reject(new Error('not used')),
    listTeamTokens: () => Promise.reject(new Error('not used')),
    revokeTeamToken: () => Promise.reject(new Error('not used')),
    getSyncStatus: () => Promise.reject(new Error('not used')),
    syncNow: () => Promise.reject(new Error('not used')),
    getLicense: () => Promise.reject(new Error('not used')),
    installLicense: () => Promise.reject(new Error('not used')),
    getTeamKeys: () => Promise.reject(new Error('not used')),
    foundTeam: () => Promise.reject(new Error('not used')),
    trustFounder: () => Promise.reject(new Error('not used')),
    inviteToTeam: () => Promise.reject(new Error('not used')),
    joinTeam: () => Promise.reject(new Error('not used')),
    recoverTeam: () => Promise.reject(new Error('not used')),
    newRecoveryCode: () => Promise.reject(new Error('not used')),
    shareTeamLicense: () => Promise.reject(new Error('not used')),
    admitReplica: () => Promise.reject(new Error('not used')),
    revokeReplica: () => Promise.reject(new Error('not used')),
    setReplicaRole: () => Promise.reject(new Error('not used')),
    setReplicaHosts: () => Promise.reject(new Error('not used')),
    closeLegacy: () => Promise.reject(new Error('not used')),
    dismissRosterOp: () => Promise.reject(new Error('not used')),
    abandonInvite: () => Promise.reject(new Error('not used')),
    ackProblem: () => Promise.reject(new Error('not used')),
  };
}

function makeRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-1',
    prompt: 'do something',
    state: 'running',
    messages: [],
    questions: [],
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

  // A plan that never settles must point at `dispatch plan show <plan-id>`
  // rather than being a bare "did not settle" dead end.
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
