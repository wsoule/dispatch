import type { AuthResult } from '@dispatch/a2a';
import type { AgentRecord } from '@dispatch/protocol';
import { expect, it } from 'bun:test';

import {
  authenticateA2AClient,
  isA2AClientToken,
  tokenHash,
} from '../../src/a2a/auth.js';

const rows = new Map<string, AgentRecord>();
const agents = { agentByTokenHash: (h: string) => rows.get(h) ?? null };
function put(address: string, token: string, status: AgentRecord['status']) {
  rows.set(tokenHash(token), {
    address,
    displayName: address,
    client: 'a2a',
    tokenHash: tokenHash(token),
    status,
    muted: false,
    approvedBy: null,
    createdAt: '2026-09-25T00:00:00.000Z',
  });
}
put('agent:wyat/a2a.acme', 'ok', 'approved');
put('agent:wyat/a2a.wait', 'pending', 'pending');
put('agent:wyat/a2a.gone', 'revoked', 'revoked');
put('agent:wyat/claude', 'mcp', 'approved');

it('accepts an approved client with a clients row', () => {
  expect(authenticateA2AClient(agents, () => 'bearer', 'ok')).toEqual({
    ok: true,
    caller: { address: 'agent:wyat/a2a.acme', name: 'a2a.acme' },
  });
});

it('gives one uniform 401 to every bearer that is not an A2A client, and to a client with no row', () => {
  const uniform: AuthResult = {
    ok: false,
    status: 401,
    reason: 'AUTH_INVALID_TOKEN',
    message: 'unknown token',
  };
  expect(authenticateA2AClient(agents, () => 'bearer', 'mcp')).toEqual(uniform);
  expect(authenticateA2AClient(agents, () => 'bearer', 'never-issued')).toEqual(
    uniform
  );
  expect(authenticateA2AClient(agents, () => null, 'ok')).toEqual(uniform);
  // A row that signs refuses its bearer the same way (P5, review M6).
  expect(authenticateA2AClient(agents, () => 'signature', 'ok')).toEqual(
    uniform
  );
  expect(authenticateA2AClient(agents, () => 'link', 'ok')).toEqual(uniform);
});

it('names pending and revoked clients', () => {
  expect(
    authenticateA2AClient(agents, () => 'bearer', 'pending')
  ).toMatchObject({
    status: 403,
    reason: 'AUTH_AGENT_PENDING',
  });
  expect(
    authenticateA2AClient(agents, () => 'bearer', 'revoked')
  ).toMatchObject({
    status: 401,
    reason: 'AUTH_AGENT_REVOKED',
  });
});

it('classifies from the agent row alone', () => {
  expect(isA2AClientToken(agents, 'revoked')).toBe(true);
  expect(isA2AClientToken(agents, 'mcp')).toBe(false);
});
