import { gateOf } from '@dispatch/protocol';
import { afterEach, expect, it } from 'bun:test';

import { tokenHash } from '../../src/a2a/auth.js';
import type { ApiContext } from '../../src/api.js';
import type { AgentRegistration } from '../../src/messaging/routes.js';
import { registerAgentRow } from '../../src/messaging/routes.js';
import type { Messaging } from '../../src/messaging/service.js';
import {
  makeOrchestrator,
  openRecovered,
  useTempProject,
} from '../messaging/harness.js';

const project = useTempProject();
const opened: Messaging[] = [];

afterEach(() => {
  for (const messaging of opened.splice(0)) messaging.close();
});

// registerAgentRow reads only messaging and the owner's ref, so a cast subset
// stands in for the full ApiContext.
async function harness(): Promise<{ ctx: ApiContext; messaging: Messaging }> {
  const { orchestrator, store } = makeOrchestrator(project.root());
  const messaging = await openRecovered(project.root(), orchestrator, store);
  opened.push(messaging);
  const ctx = {
    messaging,
    actorContext: { humanRef: 'human:wyat' },
  } as unknown as ApiContext;
  return { ctx, messaging };
}

function registration(
  overrides: Partial<AgentRegistration> = {}
): AgentRegistration {
  return {
    name: 'a2a.acme',
    displayName: 'Acme',
    client: 'a2a',
    requester: 'human:wyat',
    gateBody: 'New A2A client agent:wyat/a2a.acme wants to reach this project.',
    refuseAnyExisting: true,
    ...overrides,
  };
}

it('writes a pending row whose token hashes to it, gated with the given body', async () => {
  const { ctx, messaging } = await harness();
  const reg = await registerAgentRow(ctx, registration());
  if (!reg.ok) throw new Error(await reg.response.text());
  expect(reg.address).toBe('agent:wyat/a2a.acme');
  expect(reg.record).toMatchObject({ status: 'pending', client: 'a2a' });
  expect(messaging.store.agentByTokenHash(tokenHash(reg.token))?.address).toBe(
    reg.address
  );
  const gate = messaging.engine
    .openBlocking()
    .find((m) => gateOf(m)?.type === 'agent-registration');
  expect(gate?.body).toBe(registration().gateBody);
});

it('refuses a name that was ever registered, revoked included, when asked to', async () => {
  const { ctx, messaging } = await harness();
  const first = await registerAgentRow(ctx, registration());
  if (!first.ok) throw new Error(await first.response.text());
  messaging.store.putAgent({ ...first.record, status: 'revoked' });

  const again = await registerAgentRow(ctx, registration());
  expect(again.ok).toBe(false);
  if (again.ok) return;
  expect(again.response.status).toBe(409);
  expect(((await again.response.json()) as { error: string }).error).toContain(
    'was registered before'
  );

  const reused = await registerAgentRow(
    ctx,
    registration({ refuseAnyExisting: false })
  );
  expect(reused.ok).toBe(true);
});

it('tells a refused client name to choose a new one, whatever the row status', async () => {
  const { ctx } = await harness();
  const first = await registerAgentRow(ctx, registration());
  if (!first.ok) throw new Error(await first.response.text());

  const again = await registerAgentRow(ctx, registration());
  expect(again.ok).toBe(false);
  if (again.ok) return;
  expect(again.response.status).toBe(409);
  const { error } = (await again.response.json()) as { error: string };
  expect(error).toContain('choose a new name');
  expect(error).not.toContain('revoke');

  const ordinary = await registerAgentRow(
    ctx,
    registration({ refuseAnyExisting: false })
  );
  if (ordinary.ok) throw new Error('expected a 409 for a pending row');
  expect(
    ((await ordinary.response.json()) as { error: string }).error
  ).toContain('ask a human to revoke it first');
});
