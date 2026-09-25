import type { Message, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { pendingApprovalsFromGates } from './pendingApprovals';

function run(id: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: `Task ${id}`,
    executor: 'fake',
    state: 'awaiting-approval',
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/wt/${id}`,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:01:00.000Z',
    ...overrides,
  };
}

// A tool-approval gate as dispatchd sends it: from the system, to the owner.
function gate(
  id: string,
  data: Record<string, unknown>,
  createdAt = '2026-09-14T00:00:30.000Z'
): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'agent:dispatch',
    to: ['human:wyat'],
    kind: 'question',
    body: 'Bash wants to run',
    refs: [],
    urgent: false,
    blocking: true,
    choices: ['approve', 'approve-session', 'deny'],
    wake: 'none',
    createdAt,
    data: { type: 'tool-approval', tool: 'Bash', input: {}, ...data },
  };
}

describe('pendingApprovalsFromGates', () => {
  // The reload case: the open gate alone puts an Approve button back in front
  // of the human, with the preview the gate carries.
  test('a parked run is answerable from its open gate', () => {
    const approvals = pendingApprovalsFromGates(
      [gate('m-1', { requestId: 'req-1', runId: 'a', input: { cmd: 'ls' } })],
      [run('a')]
    );
    expect(approvals.get('a')).toEqual({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { cmd: 'ls' },
    });
  });

  test('a run that is no longer awaiting approval contributes nothing', () => {
    const approvals = pendingApprovalsFromGates(
      [gate('m-1', { requestId: 'stale', runId: 'a' })],
      [run('a', { state: 'finished' })]
    );
    expect(approvals.size).toBe(0);
  });

  test('before the first run list arrives, open gates stand on their own', () => {
    const approvals = pendingApprovalsFromGates(
      [gate('m-1', { requestId: 'req-1', runId: 'a' })],
      undefined
    );
    expect(approvals.get('a')?.requestId).toBe('req-1');
  });

  // Parallel tool calls park one gate each; the oldest is answered first.
  test('a run with two open approvals shows the oldest', () => {
    const approvals = pendingApprovalsFromGates(
      [
        gate('m-2', { requestId: 'req-2', runId: 'a' }, '2026-09-14T00:00:40Z'),
        gate('m-1', { requestId: 'req-1', runId: 'a' }, '2026-09-14T00:00:30Z'),
      ],
      [run('a')]
    );
    expect(approvals.get('a')?.requestId).toBe('req-1');
  });

  // An overseer conversation's gate has no run; the chat shows it.
  test('a conversation-bound approval and other gates are not run approvals', () => {
    const approvals = pendingApprovalsFromGates(
      [
        gate('m-1', { requestId: 'req-1', conversation: 'wc-1' }),
        { ...gate('m-2', {}), data: { type: 'scope', paths: [], reason: 'x' } },
      ],
      undefined
    );
    expect(approvals.size).toBe(0);
  });
});
