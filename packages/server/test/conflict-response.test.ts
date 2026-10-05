import { describe, expect, it } from 'bun:test';

import { conflictResponse } from '../src/api/http.js';
import { OrchestratorConflictError } from '../src/orchestrator/types.js';

describe('conflictResponse', () => {
  const revoked = new OrchestratorConflictError(
    'the overseer is revoked',
    'overseer_revoked',
    'approve agent:wyat/overseer in Agents to use it again'
  );

  it('tells an operator how to act, and no one else', async () => {
    expect(await conflictResponse(revoked, 'operator').json()).toEqual({
      error:
        'the overseer is revoked: approve agent:wyat/overseer in Agents to use it again',
      code: 'overseer_revoked',
    });
    for (const tier of ['decide', 'request', undefined] as const) {
      const res = conflictResponse(revoked, tier);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'the overseer is revoked',
        code: 'overseer_revoked',
      });
    }
  });

  it('answers a plain conflict with its message alone', async () => {
    expect(
      await conflictResponse(
        new OrchestratorConflictError('busy'),
        'operator'
      ).json()
    ).toEqual({ error: 'busy' });
  });
});
