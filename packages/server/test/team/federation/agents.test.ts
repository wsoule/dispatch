import type { AgentRecord } from '@dispatch-foo/protocol';
import { afterEach, describe, expect, it } from 'bun:test';

import type { ApiContext } from '../../../src/api.js';
import {
  approveAgent,
  muteAgent,
  revokeAgent,
} from '../../../src/messaging/routes.js';
import { foundedTeam } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const agent = (
  address: string,
  status: AgentRecord['status'] = 'approved',
  tokenHash = 'a'.repeat(64)
): AgentRecord => ({
  address,
  displayName: address,
  client: 'codex',
  tokenHash,
  status,
  muted: false,
  approvedBy: 'human:bob',
  createdAt: '2026-09-26T00:00:00.000Z',
});
// The context the agent routes read: this replica's messaging and labels.
const ctxOf = (r: MessagingReplica): ApiContext =>
  ({
    principal: { address: 'human:ada', canDecide: true, kind: 'human' },
    messaging: { store: r.messages, engine: r.engine },
    federation: {
      fed: r.fed,
      roster: r.roster,
      label: (replica: string) => r.roster.label(replica),
    },
  }) as unknown as ApiContext;

describe('agents across daemons', () => {
  it('replicates an agent without its token hash, as a row no local token can match', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).messages.putAgent(agent('agent:bob/codex'));
    await at(0).settleWith(at(1));
    expect(at(0).messages.getAgent('agent:bob/codex')).toMatchObject({
      status: 'approved',
      tokenHash: 'remote:agent:bob/codex',
    });
    expect(at(0).messages.agentByTokenHash('a'.repeat(64))).toBeNull();
    const ops = at(1).remote.logs.get(at(1).fed.replica) ?? [];
    expect(JSON.stringify(ops)).not.toContain('a'.repeat(64));
  });

  it('publishes no agent while the founding pin is not firm', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).fed.setMeta('founder_pin', 'auto');
    const before = at(1).fed.head()?.seq;
    at(1).messages.putAgent(agent('agent:bob/codex'));
    at(1).agents.collect();
    expect(at(1).fed.head()?.seq).toBe(before);
  });

  it('publishes a change once, and again only when it changes', async () => {
    open = await foundedTeam('ada', 'bob');
    const agentOps = () =>
      (at(1).remote.logs.get(at(1).fed.replica) ?? []).filter(
        (e) => e.type === 'agent'
      ).length;
    at(1).messages.putAgent(agent('agent:bob/codex', 'pending'));
    await at(1).service.syncNow();
    await at(1).service.syncNow();
    expect(agentOps()).toBe(1);
    at(1).messages.putAgent(agent('agent:bob/codex', 'approved'));
    await at(0).settleWith(at(1));
    expect(agentOps()).toBe(2);
    expect(at(0).messages.getAgent('agent:bob/codex')?.status).toBe('approved');
  });

  it('never publishes an overseer or A2A agent, and refuses one arriving', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).messages.putAgent(agent('agent:bob/overseer'));
    at(1).messages.putAgent(
      agent('agent:bob/a2a.acme', 'approved', 'c'.repeat(64))
    );
    await at(0).settleWith(at(1));
    expect(at(0).messages.getAgent('agent:bob/overseer')).toBeNull();
    expect(at(0).messages.getAgent('agent:bob/a2a.acme')).toBeNull();
    at(1).fed.append({
      type: 'agent',
      body: {
        address: 'agent:bob/overseer',
        displayName: 'x',
        client: 'x',
        status: 'approved',
      },
    });
    await at(0).settleWith(at(1));
    expect(at(0).messages.getAgent('agent:bob/overseer')).toBeNull();
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.message.includes('agent:bob/overseer'))
    ).toBe(true);
  });

  it('refuses an agent published by a machine that cannot speak for its operator', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    at(2).fed.append({
      type: 'agent',
      body: {
        address: 'agent:bob/codex',
        displayName: 'x',
        client: 'x',
        status: 'approved',
      },
    });
    await at(0).settleWith(at(2));
    expect(at(0).messages.getAgent('agent:bob/codex')).toBeNull();
    expect(
      at(0)
        .fed.db.query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM fed_audit WHERE kind = 'speaks-for'"
        )
        .get()?.n
    ).toBe(1);
  });

  it('keeps a local registration over a remote one of the same address, with a problem', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).messages.putAgent({
      ...agent('agent:bob/codex'),
      tokenHash: 'b'.repeat(64),
    });
    at(1).messages.putAgent(agent('agent:bob/codex'));
    await at(0).settleWith(at(1));
    expect(at(0).messages.getAgent('agent:bob/codex')?.tokenHash).toBe(
      'b'.repeat(64)
    );
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.subject === 'agent:agent:bob/codex')
    ).toBe(true);
  });

  it('lets a remote agent be muted here but never approved or revoked here', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).messages.putAgent(agent('agent:bob/codex', 'pending'));
    await at(0).settleWith(at(1));
    for (const route of [approveAgent, revokeAgent]) {
      const res = await route(ctxOf(at(0)), 'agent:bob/codex');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(
        "registered on bob's machine"
      );
    }
    expect(muteAgent(ctxOf(at(0)), 'agent:bob/codex').status).toBe(200);
    expect(at(0).messages.getAgent('agent:bob/codex')?.muted).toBe(true);
    // A later op keeps the local mute.
    at(1).messages.putAgent(agent('agent:bob/codex', 'approved'));
    await at(0).settleWith(at(1));
    expect(at(0).messages.getAgent('agent:bob/codex')).toMatchObject({
      status: 'approved',
      muted: true,
    });
  });

  it("turns a revoked replica's agents revoked, so their mail is refused", async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).messages.putAgent(agent('agent:bob/codex'));
    await at(0).settleWith(at(1));
    expect(at(0).messages.getAgent('agent:bob/codex')?.status).toBe('approved');
    at(0).roster.revoke(at(1).fed.replica, 'left the team');
    await at(0).service.syncNow();
    expect(at(0).messages.getAgent('agent:bob/codex')?.status).toBe('revoked');
  });
});
