import type { AgentSummary, Message } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  agentRosterKey,
  handleOf,
  mayChangeAgentRoster,
  mutedAddresses,
  rosterActions,
  sortRoster,
} from './agentRoster';

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    address: 'agent:wyat/claude-code.macbook',
    displayName: 'claude-code.macbook',
    client: 'claude-code',
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

describe('sortRoster', () => {
  test('puts pending first, then approved, then revoked, newest first within each', () => {
    const sorted = sortRoster([
      agent({
        address: 'agent:a/old-approved',
        createdAt: '2026-09-01T00:00:00Z',
      }),
      agent({ address: 'agent:a/revoked', status: 'revoked' }),
      agent({
        address: 'agent:a/new-approved',
        createdAt: '2026-09-22T00:00:00Z',
      }),
      agent({
        address: 'agent:a/pending',
        status: 'pending',
        approvedBy: null,
      }),
    ]);
    expect(sorted.map((a) => a.address)).toEqual([
      'agent:a/pending',
      'agent:a/new-approved',
      'agent:a/old-approved',
      'agent:a/revoked',
    ]);
  });

  test('leaves its input alone', () => {
    const input = [agent({ status: 'revoked' }), agent({ status: 'pending' })];
    sortRoster(input);
    expect(input.map((a) => a.status)).toEqual(['revoked', 'pending']);
  });
});

describe('rosterActions', () => {
  test('a pending agent can be approved, muted or revoked', () => {
    expect(rosterActions(agent({ status: 'pending' }))).toEqual({
      approve: true,
      mute: true,
      revoke: true,
    });
  });

  test('an approved agent can be muted or revoked, not approved again', () => {
    expect(rosterActions(agent())).toEqual({
      approve: false,
      mute: true,
      revoke: true,
    });
  });

  test('a revoked agent offers nothing: it must register again', () => {
    expect(rosterActions(agent({ status: 'revoked' }))).toEqual({
      approve: false,
      mute: false,
      revoke: false,
    });
  });
});

describe('mutedAddresses', () => {
  test('lists the agents a decider muted, and nobody else', () => {
    const muted = mutedAddresses([
      agent({ address: 'agent:a/quiet', muted: true }),
      agent({ address: 'agent:a/loud' }),
      agent({ address: 'agent:a/gone', status: 'revoked', muted: true }),
    ]);
    expect([...muted].sort()).toEqual(['agent:a/gone', 'agent:a/quiet']);
    expect(mutedAddresses([]).size).toBe(0);
  });
});

describe('handleOf', () => {
  test('drops the kind from an address', () => {
    expect(handleOf('human:wyat')).toBe('wyat');
    expect(handleOf('agent:wyat/claude-code.macbook')).toBe(
      'wyat/claude-code.macbook'
    );
  });

  test('keeps a value with no kind as it is', () => {
    expect(handleOf('wyat')).toBe('wyat');
  });
});

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    thread: 'm-1',
    replyTo: null,
    from: 'run:r-1',
    to: ['human:wyat'],
    kind: 'message',
    body: 'hello',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

describe('mayChangeAgentRoster', () => {
  test('a registration gate adds a pending agent', () => {
    expect(
      mayChangeAgentRoster(
        message({
          from: 'system',
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          data: {
            type: 'agent-registration',
            agent: 'agent:wyat/cursor.macbook',
            client: 'cursor',
            requestedBy: 'human:wyat',
          },
        })
      )
    ).toBe(true);
  });

  test('an answer may settle a registration gate', () => {
    expect(
      mayChangeAgentRoster(
        message({
          from: 'human:wyat',
          to: ['system'],
          kind: 'answer',
          replyTo: 'm-0',
          choice: 'approve',
        })
      )
    ).toBe(true);
  });

  test('ordinary traffic and other gates leave the roster alone', () => {
    expect(mayChangeAgentRoster(message())).toBe(false);
    expect(
      mayChangeAgentRoster(
        message({
          kind: 'question',
          blocking: true,
          data: { type: 'tool-approval', runId: 'r-1', requestId: 'q-1' },
        })
      )
    ).toBe(false);
  });
});

test('the roster key is per daemon port', () => {
  expect(agentRosterKey(4000)).toEqual(['dispatch-agent-roster', 4000]);
  expect(agentRosterKey(4001)).not.toEqual(agentRosterKey(4000));
});
