import type { AgentSummary } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { handleOf, rosterActions, sortRoster } from './agentRoster';

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
