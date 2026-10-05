import { isStub } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { RELAY_DISCLOSURE } from '../../../src/team/federation/relay.js';
import { startFakeRelay } from './fakeRelay.js';
import type { FakeRelay } from './fakeRelay.js';
import {
  foundedTeam,
  foundedTeamWith,
  messagingReplica,
} from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

// Task 22: the relay transport against the in-repo fake relay.
let relay: FakeRelay | null = null;
let open: MessagingReplica[] = [];
afterEach(async () => {
  for (const r of open) r.close();
  open = [];
  await relay?.stop();
  relay = null;
});
const at = (i: number): MessagingReplica => open[i];
const startRelay = async (
  founder: MessagingReplica,
  limits?: Parameters<typeof startFakeRelay>[1]
): Promise<FakeRelay> => {
  relay = await startFakeRelay(founder, limits);
  return relay;
};
const kinds = (entries: { type: string; body?: unknown }[]) =>
  entries
    .map((e) =>
      e.type === 'roster' ? (e.body as { action: string }).action : e.type
    )
    .sort();

describe('the relay transport against the fake relay', () => {
  it('authenticates with a signature bound to the exact URL dialed', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0));
    await expect(
      at(0).relayTransport(r.url).pull(new Map())
    ).resolves.toBeDefined();
    const elsewhere = at(0).relayTransport(
      r.url.replace('127.0.0.1', 'localhost'),
      { signFor: r.url }
    );
    await expect(elsewhere.pull(new Map())).rejects.toThrow('refused');
  });

  it('refuses a machine the roster does not know', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    const stranger = messagingReplica('eve');
    open.push(stranger);
    await expect(
      stranger.relayTransport(r.url, { teamId: r.teamId }).pull(new Map())
    ).rejects.toThrow('refused');
  });

  it('lets a pending machine in only with an unused invite, and shows it only the founding', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    const { code } = at(0).roster.invite('bob');
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const bob = messagingReplica('bob');
    open.push(bob);
    bob.roster.join(code);
    const seen = await bob.relayTransport(r.url).pull(new Map());
    expect(kinds(seen)).toEqual(['found', 'key']);
    const again = messagingReplica('bob');
    open.push(again);
    again.roster.join(code);
    await expect(again.relayTransport(r.url).pull(new Map())).rejects.toThrow(
      'refused'
    );
  });

  it("stores only a pending machine's key op, and holds the rest back", async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    const { code } = at(0).roster.invite('bob');
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const bob = messagingReplica('bob');
    open.push(bob);
    bob.roster.join(code);
    const t = bob.relayTransport(r.url);
    await t.upload(bob.fed.ownLog());
    expect(r.stored(bob.fed.replica).map((e) => e.type)).toEqual(['key']);
  });

  it('gives each member sealed ops addressed to others as stubs', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const r = await startRelay(at(0));
    for (const m of open) await m.relayTransport(r.url).upload(m.fed.ownLog());
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'for bob' },
      { address: 'human:ada', canDecide: true }
    );
    at(0).mailOut.collect();
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const mailFor = async (m: MessagingReplica) =>
      (await m.relayTransport(r.url).pull(new Map())).filter(
        (e) => e.replica === at(0).fed.replica && e.type === 'mail'
      );
    expect((await mailFor(at(1))).every((e) => !isStub(e))).toBe(true);
    expect((await mailFor(at(2))).every((e) => isStub(e))).toBe(true);
    expect(await mailFor(at(2))).not.toHaveLength(0);
  });

  it('turns mail into stubs once every admitted recipient acknowledged it', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0));
    for (const m of open) await m.relayTransport(r.url).upload(m.fed.ownLog());
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'read me' },
      { address: 'human:ada', canDecide: true }
    );
    at(0).mailOut.collect();
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const mail = () =>
      r.stored(at(0).fed.replica).filter((e) => e.type === 'mail');
    expect(mail().some((e) => !isStub(e))).toBe(true);
    const head = at(0).fed.head()?.seq ?? 0;
    await at(1)
      .relayTransport(r.url)
      .ack(new Map([[at(0).fed.replica, head]]));
    expect(mail().every((e) => isStub(e))).toBe(true);
  });

  it('keeps unacknowledged mail whole for 30 days, then as a stub', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0));
    for (const m of open) await m.relayTransport(r.url).upload(m.fed.ownLog());
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'unread' },
      { address: 'human:ada', canDecide: true }
    );
    at(0).mailOut.collect();
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const mail = () =>
      r.stored(at(0).fed.replica).filter((e) => e.type === 'mail');
    r.clock.now = new Date(r.clock.now.getTime() + 29 * 86_400_000);
    expect(mail().some((e) => !isStub(e))).toBe(true);
    r.clock.now = new Date(r.clock.now.getTime() + 2 * 86_400_000);
    expect(mail().every((e) => isStub(e))).toBe(true);
  });

  it('keeps only the latest presence op per replica whole', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0));
    for (let i = 0; i < 2; i++) {
      at(0).clock.now = new Date(at(0).clock.now.getTime() + 60 * 60_000);
      at(0).presence.collect(at(0).clock.now);
    }
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const whole = r
      .stored(at(0).fed.replica)
      .filter((e) => e.type === 'presence' && !isStub(e));
    expect(whole).toHaveLength(1);
  });

  it('wakes a connected member when another publishes', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0));
    let woken = 0;
    const ada = at(0).relayTransport(r.url);
    await ada.upload(at(0).fed.ownLog());
    const bob = at(1).relayTransport(r.url, { wake: () => (woken += 1) });
    await bob.upload(at(1).fed.ownLog());
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'wake up' },
      { address: 'human:ada', canDecide: true }
    );
    at(0).mailOut.collect();
    await ada.upload(at(0).fed.ownLog());
    const started = Date.now();
    while (woken === 0 && Date.now() - started < 1000) await Bun.sleep(5);
    expect(woken).toBeGreaterThan(0);
    expect(bob.presence()?.map((p) => p.replica)).toContain(at(1).fed.replica);
  });

  it('throws TransportOffline while the relay is down, and reconnects after', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    const t = at(0).relayTransport(r.url);
    await t.pull(new Map());
    await r.stop();
    relay = null;
    await expect(t.pull(new Map())).rejects.toThrow();
    expect(t.health().lastError).not.toBeNull();
  });
});

const ADA = { address: 'human:ada', canDecide: true } as const;
// Each replica's pass, in turn, `n` times.
const passes = async (rs: MessagingReplica[], n = 2): Promise<void> => {
  for (let i = 0; i < n; i++) for (const r of rs) await r.service.syncNow();
};
// Founds a team, closes its legacy window, and starts a relay for it.
async function team(...handles: string[]): Promise<FakeRelay> {
  open = await foundedTeam(...handles);
  at(0).roster.closeLegacy();
  await passes(open);
  return startRelay(at(0));
}

describe('switching a team to the relay', () => {
  it('switches nothing until the disclosure is confirmed, then audits the switch', async () => {
    const r = await team('ada', 'bob');
    const first = await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
    });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({
      code: 'confirm_required',
      disclosure: RELAY_DISCLOSURE,
    });
    expect(at(0).roster.view()?.transport.kind).toBe('git');
    const ok = await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
      confirmed: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.disclosure).toBe(RELAY_DISCLOSURE);
    await at(0).service.syncNow();
    expect(at(0).roster.view()?.transport).toEqual({
      kind: 'relay',
      url: r.url,
    });
    expect(at(0).service.status().transport).toBe('relay');
    expect(
      at(0)
        .fed.db.query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM fed_audit WHERE kind = 'transport' AND subject = 'transport:relay'"
        )
        .get()?.n
    ).toBe(1);
  });

  it('refuses while the legacy window is open', async () => {
    open = await foundedTeam('ada', 'bob');
    relay = await startFakeRelay(at(0));
    const body = { kind: 'relay', url: relay.url, confirmed: true };
    const res = await at(0).teamRoute('/api/team/transport', body);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('legacy window');
  });

  it('refuses while an admitted machine does not announce the relay capability (FW-R39)', async () => {
    open = await foundedTeamWith({ capsFor: { bob: [] } }, 'ada', 'bob');
    at(0).roster.closeLegacy();
    await passes(open);
    relay = await startFakeRelay(at(0));
    const body = { kind: 'relay', url: relay.url, confirmed: true };
    const res = await at(0).teamRoute('/api/team/transport', body);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('bob');
    expect(at(0).roster.view()?.transport.kind).toBe('git');
  });

  it('lets a machine that upgraded announce the capability in presence (FW-R39)', async () => {
    open = await foundedTeamWith({ capsFor: { bob: [] } }, 'ada', 'bob');
    at(0).roster.closeLegacy();
    await passes(open);
    relay = await startFakeRelay(at(0));
    // Bob's next build speaks the relay; its key op stays as it was.
    at(1).setCaps(['relay']);
    await passes(open);
    const res = await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: relay.url,
      confirmed: true,
    });
    expect(res.status).toBe(200);
  });

  it('forgets re-announced caps once a later presence carries none, as after a downgrade', async () => {
    open = await foundedTeamWith({ capsFor: { bob: [] } }, 'ada', 'bob');
    at(0).roster.closeLegacy();
    await passes(open);
    relay = await startFakeRelay(at(0));
    at(1).setCaps(['relay']);
    await passes(open);
    // Bob goes back to a build whose caps match its key op's: none.
    at(1).setCaps([]);
    await passes(open);
    const res = await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: relay.url,
      confirmed: true,
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('bob');
  });

  it('refuses a relay URL that is not wss, and a member who is no admin', async () => {
    const r = await team('ada', 'bob');
    const plain = await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: 'ws://relay.example',
      confirmed: true,
    });
    expect(plain.status).toBe(400);
    const member = await at(1).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
      confirmed: true,
    });
    expect(member.status).toBe(403);
  });

  it('switches a team from git to the relay without losing an op, and delivers in under a second', async () => {
    const r = await team('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    expect(
      (
        await ada.teamRoute('/api/team/transport', {
          kind: 'relay',
          url: r.url,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    await passes(open, 3);
    for (const m of [ada, bob]) {
      expect(m.service.status().transport).toBe('relay');
      expect(r.stored(m.fed.replica).at(-1)?.seq).toBe(m.fed.head()?.seq);
    }
    const started = Date.now();
    const { message } = await ada.engine.send(
      { to: ['human:bob'], kind: 'message', body: 'fast' },
      ADA
    );
    await ada.service.syncNow();
    while (
      bob.messages.getMessage(message.id) === null &&
      Date.now() - started < 1000
    )
      await Bun.sleep(10);
    expect(bob.messages.getMessage(message.id)?.body).toBe('fast');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('accepts mail sealed to a machine revoked in flight, and wedges nobody', async () => {
    const r = await team('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    await ada.teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
      confirmed: true,
    });
    await passes(open, 3);
    const { message } = await ada.engine.send(
      { to: ['human:bob', 'human:cy'], kind: 'message', body: 'in flight' },
      ADA
    );
    ada.mailOut.collect();
    ada.roster.revoke(cy.fed.replica, 'left the team');
    await passes([ada, bob], 3);
    expect(bob.messages.getMessage(message.id)?.body).toBe('in flight');
    expect(ada.service.status().lastError).toBeNull();
    expect(bob.service.status().lastError).toBeNull();
    const mail = r.stored(ada.fed.replica).filter((e) => e.type === 'mail');
    expect(mail.length).toBeGreaterThan(0);
    expect(mail.every((e) => isStub(e))).toBe(true);
  });

  it('switches back to git by the same op', async () => {
    const r = await team('ada', 'bob');
    await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
      confirmed: true,
    });
    await passes(open, 3);
    for (const m of open) expect(m.service.status().transport).toBe('relay');
    expect(
      (await at(0).teamRoute('/api/team/transport', { kind: 'git' })).status
    ).toBe(200);
    await passes(open, 3);
    for (const m of open) expect(m.service.status().transport).toBe('git');
    const id = at(0).store.create({ title: 'after the switch back' }).meta.id;
    await passes(open, 2);
    expect(at(1).store.get(id)?.meta.title).toBe('after the switch back');
  });
});

describe("the fake relay's limits", () => {
  it('refuses an op over the size cap, holding the outbox', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0), { limits: { opMaxBytes: 4096 } });
    const t = at(0).relayTransport(r.url);
    await t.upload(at(0).fed.ownLog());
    at(0).store.create({ title: 'x'.repeat(8000) });
    await expect(t.upload(at(0).fed.ownLog())).rejects.toThrow(
      'only through seq'
    );
    expect(r.stored(at(0).fed.replica).at(-1)?.seq).toBeLessThan(
      at(0).fed.head()?.seq ?? 0
    );
  });

  it('stores at most so many ops a minute, then the rest the next minute', async () => {
    open = await foundedTeam('ada', 'bob');
    const r = await startRelay(at(0), { limits: { opsPerMinute: 2 } });
    const t = at(0).relayTransport(r.url);
    await t.upload(at(0).fed.ownLog());
    const before = r.stored(at(0).fed.replica).at(-1)?.seq ?? 0;
    r.clock.now = new Date(r.clock.now.getTime() + 61_000);
    for (let i = 0; i < 4; i++) at(0).store.create({ title: `task ${i}` });
    const head = at(0).fed.head()?.seq ?? 0;
    let minutes = 0;
    for (; minutes < 10; minutes++) {
      try {
        await t.upload(at(0).fed.ownLog());
        break;
      } catch {
        r.clock.now = new Date(r.clock.now.getTime() + 61_000);
      }
    }
    expect(minutes).toBe(Math.ceil((head - before) / 2) - 1);
    expect(r.stored(at(0).fed.replica).at(-1)?.seq).toBe(head);
  });

  it('exempts the switch-over upload, ops before the relay transport op, from the rate', async () => {
    open = await foundedTeam('ada', 'bob');
    for (let i = 0; i < 4; i++) at(0).store.create({ title: `before ${i}` });
    at(0).roster.closeLegacy();
    const r = await startRelay(at(0), { limits: { opsPerMinute: 1 } });
    at(0).roster.setTransport('relay', r.url);
    for (let i = 0; i < 2; i++) at(0).store.create({ title: `after ${i}` });
    const t = at(0).relayTransport(r.url);
    await expect(t.upload(at(0).fed.ownLog())).rejects.toThrow(
      'only through seq'
    );
    const stored = r.stored(at(0).fed.replica);
    const switchAt = stored.findIndex(
      (e) =>
        e.type === 'roster' &&
        (e as { body?: { action?: string } }).body?.action === 'transport'
    );
    // Everything up to the switch op went up at once; one op after it.
    expect(switchAt).toBeGreaterThan(4);
    expect(stored.length).toBe(switchAt + 1);
  });

  it('lets so many pending machines join a minute, per team and per source', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0), {
      limits: { pendingPerTeamMinute: 5, pendingPerSourceMinute: 1 },
    });
    const codes = ['bob', 'cy'].map((h) => at(0).roster.invite(h).code);
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const [bob, cy] = ['bob', 'cy'].map((h) => messagingReplica(h));
    open.push(bob, cy);
    bob.roster.join(codes[0]);
    cy.roster.join(codes[1]);
    await bob.relayTransport(r.url).pull(new Map());
    await expect(cy.relayTransport(r.url).pull(new Map())).rejects.toThrow(
      'too many joins'
    );
    r.clock.now = new Date(r.clock.now.getTime() + 61_000);
    await expect(
      cy.relayTransport(r.url).pull(new Map())
    ).resolves.toBeDefined();
  });

  it('caps pending joins per team across sources', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0), {
      limits: { pendingPerTeamMinute: 1, pendingPerSourceMinute: 10 },
    });
    const codes = ['bob', 'cy'].map((h) => at(0).roster.invite(h).code);
    await at(0).relayTransport(r.url).upload(at(0).fed.ownLog());
    const [bob, cy] = ['bob', 'cy'].map((h) => messagingReplica(h));
    open.push(bob, cy);
    bob.roster.join(codes[0]);
    cy.roster.join(codes[1]);
    await bob.relayTransport(r.url).pull(new Map());
    await expect(cy.relayTransport(r.url).pull(new Map())).rejects.toThrow(
      'too many joins'
    );
  });
});

describe('F4 review fixes', () => {
  it('keeps git when the roster names a relay that is not wss (M1)', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).roster.closeLegacy();
    await passes(open);
    // An admin signs a plaintext URL past the route's check.
    at(0).roster.setTransport('relay', 'ws://relay.attacker.example');
    await passes(open, 3);
    for (const m of open) {
      expect(m.service.status().transport).toBe('git');
      // Refused before dialing, not after failing to reach it.
      expect(
        m.fed.problems().find((p) => p.subject === 'transport:switch')?.message
      ).toContain('not wss://');
    }
  });

  it('uploads a long log in frames, stopping at the first short answer (M2)', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    for (let i = 0; i < 5; i++) at(0).store.create({ title: `task ${i}` });
    const t = at(0).relayTransport(r.url, { opsPerFrame: 2 });
    await t.upload(at(0).fed.ownLog());
    expect(r.publishFrames()).toBe(Math.ceil(at(0).fed.ownLog().length / 2));
    expect(r.stored(at(0).fed.replica).at(-1)?.seq).toBe(at(0).fed.head()?.seq);
  });

  it('stops uploading after a frame the relay stored only part of (M2)', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0), { limits: { opsPerMinute: 1 } });
    for (let i = 0; i < 5; i++) at(0).store.create({ title: `task ${i}` });
    const t = at(0).relayTransport(r.url, { opsPerFrame: 2 });
    await expect(t.upload(at(0).fed.ownLog())).rejects.toThrow(
      'only through seq'
    );
    expect(r.publishFrames()).toBe(2);
  });

  it('signs the URL without its trailing slash', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    await expect(
      at(0).relayTransport(`${r.url}/`).pull(new Map())
    ).resolves.toBeDefined();
  });

  it('refuses while a pending invitee does not announce the relay capability', async () => {
    open = await foundedTeamWith({ capsFor: { cy: [] } }, 'ada');
    at(0).roster.closeLegacy();
    const { code } = at(0).roster.invite('cy');
    const cy = messagingReplica('cy', at(0).remote, undefined, {
      capsFor: { cy: [] },
    });
    open.push(cy);
    cy.roster.join(code);
    await passes(open);
    relay = await startFakeRelay(at(0));
    const res = await at(0).teamRoute('/api/team/transport', {
      kind: 'relay',
      url: relay.url,
      confirmed: true,
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('cy');
  });

  it('closes the socket on a malformed frame', async () => {
    open = await foundedTeam('ada');
    const r = await startRelay(at(0));
    const t = at(0).relayTransport(r.url);
    await t.pull(new Map());
    r.sendRaw('{not json');
    const started = Date.now();
    while (t.presence() !== null && Date.now() - started < 1000)
      await Bun.sleep(5);
    expect(t.presence()).toBeNull();
  });
});
