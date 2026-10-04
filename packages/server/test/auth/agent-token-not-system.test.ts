import { gateOf, isDecidingAuthor, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';

import { call, useWorld } from './world.js';

// XH-R2 as amended: the shared agent token is credited as agent:local-cli,
// never agent:dispatch, the messaging system address that system-keyed checks
// (system gates, doc gate senders, restore proposals) trust.

const world = useWorld();

const notSystem = (who: string | null | undefined) => {
  expect(who).toBe('agent:local-cli');
  expect(who).not.toBe(SYSTEM_ADDRESS);
  expect(isDecidingAuthor(who ?? '')).toBe(false);
};

describe('what the agent token writes', () => {
  it('never carries the system address', async () => {
    const w = world();
    const made = await call(w, w.agent, 'POST', '/api/tasks', {
      title: 'from the cli',
    });
    expect(made.status).toBe(201);
    notSystem(made.json.meta.creator);

    const patched = await call(
      w,
      w.agent,
      'PATCH',
      `/api/tasks/${made.json.meta.id}`,
      { appendActivity: 'did a thing' }
    );
    const line = (patched.json.body as string)
      .split('\n')
      .find((l) => l.includes('did a thing'));
    expect(line).toContain('agent:local-cli');
    expect(line).not.toContain(SYSTEM_ADDRESS);

    // An amendment's constraint becomes a memory proposal authored by it.
    const amended = await call(
      w,
      w.agent,
      'POST',
      `/api/tasks/${made.json.meta.id}/amend`,
      { overrides: 'use the queue', reason: 'exports race' }
    );
    expect(amended.status).toBeLessThan(300);
    expect(amended.json.memory.status).toBe('proposed');
    const proposals = w.handle.memory.shared!.listProposals();
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) notSystem(p.author);

    // The gate for it is the system's own, and names the CLI, not itself.
    const gates = w.handle.messaging.engine
      .openBlocking()
      .filter((m) => gateOf(m)?.type === 'memory');
    expect(gates.length).toBe(1);
    expect(gates[0].from).toBe(SYSTEM_ADDRESS);
    expect(gates[0].body).toContain('agent:local-cli');
  });

  it('cannot send as, or answer as, the system', async () => {
    const w = world();
    const sent = await call(w, w.agent, 'POST', '/api/messages', {
      to: ['human:test'],
      kind: 'message',
      body: 'hi',
    });
    expect(sent.status).toBe(403);
  });
});
