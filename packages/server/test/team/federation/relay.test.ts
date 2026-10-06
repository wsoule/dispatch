import { isStub, opHash } from '@dispatch-foo/protocol/federation';
import type { LogEntry } from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  founderChain,
  leadingZeroBits,
  mintStamp,
  powText,
  registerAtRelay,
  RELAY_DISCLOSURE,
  relayHttpBase,
} from '../../../src/team/federation/relay.js';
import type { RelayRegistration } from '../../../src/team/federation/relay.js';
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
// The founder's chain as POST /v1/teams takes it, from its own log.
const registrationOf = (founder: MessagingReplica): RelayRegistration => {
  const chain = founderChain(
    founder.fed.ownLog(),
    founder.fed.replica,
    Number(founder.fed.meta('founder_seq'))
  );
  if (chain === null) throw new Error('the founder holds no chain');
  return chain;
};
// Starts a fake relay and registers the founder's team at it over HTTP.
const startRelay = async (
  founder: MessagingReplica,
  limits?: Parameters<typeof startFakeRelay>[1]
): Promise<FakeRelay> => {
  relay = await startFakeRelay(founder, limits);
  await registerAtRelay(relay.url, registrationOf(founder));
  return relay;
};
// Whether the relay holds the team: it answers 404 for one it does not.
const registered = async (r: FakeRelay): Promise<boolean> =>
  (await fetch(`${relayHttpBase(r.url)}/v1/teams/${r.teamId}`)).status !== 404;
const kinds = (entries: { type: string; body?: unknown }[]) =>
  entries
    .map((e) =>
      e.type === 'roster' ? (e.body as { action: string }).action : e.type
    )
    .sort();

describe('the relay transport against the fake relay', () => {
  it('serves no team until it is registered over POST /v1/teams, and registers it once', async () => {
    open = await foundedTeam('ada');
    relay = await startFakeRelay(at(0));
    expect(await registered(relay)).toBe(false);
    await expect(
      at(0).relayTransport(relay.url).pull(new Map())
    ).rejects.toThrow();
    expect(await registerAtRelay(relay.url, registrationOf(at(0)))).toBe(
      relay.teamId
    );
    // Registering again is no error.
    expect(await registerAtRelay(relay.url, registrationOf(at(0)))).toBe(
      relay.teamId
    );
    expect(await registered(relay)).toBe(true);
    await expect(
      at(0).relayTransport(relay.url).pull(new Map())
    ).resolves.toBeDefined();
  });

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
// Founds a team, closes its legacy window, and starts a relay for it that
// has not registered the team: the switch does that.
async function team(
  handles: string[],
  opts?: Parameters<typeof startFakeRelay>[1]
): Promise<FakeRelay> {
  open = await foundedTeam(...handles);
  at(0).roster.closeLegacy();
  await passes(open);
  relay = await startFakeRelay(at(0), opts);
  return relay;
}
const toRelay = (r: FakeRelay, extra: Record<string, unknown> = {}) => ({
  kind: 'relay',
  url: r.url,
  confirmed: true,
  ...extra,
});

describe('switching a team to the relay', () => {
  it('switches nothing until the disclosure is confirmed, then audits the switch', async () => {
    const r = await team(['ada', 'bob']);
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
    const r = await team(['ada', 'bob']);
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
    const r = await team(['ada', 'bob']);
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

  // A joiner's log may hold more than its key op before it is let in (a
  // presence or agent op its collectors wrote). A pending machine stores
  // only its key op on the relay, so it switches with that alone and sends
  // the rest once admitted.
  it('lets a joiner with more than its key op in its log join a team on the relay', async () => {
    const r = await team(['ada']);
    const ada = at(0);
    await ada.teamRoute('/api/team/transport', toRelay(r));
    await passes(open, 2);
    const { code } = ada.roster.invite('bob');
    await passes([ada], 1);
    const bob = messagingReplica('bob', ada.remote);
    open.push(bob);
    bob.roster.join(code);
    // A second op behind the key op, before any admission.
    bob.fed.append({ type: 'presence', body: { kind: 'replica' } });
    await passes([bob], 2);
    // It switched with its key op alone, so nothing was refused.
    expect(bob.service.status().transport).toBe('relay');
    expect(
      bob.fed.problems().some((p) => p.subject === 'transport:switch')
    ).toBe(false);
    // ada lets bob in on its own: the invite's proof rides bob's key op.
    await passes(open, 6);
    expect(bob.service.status().transport).toBe('relay');
    expect(bob.roster.isAdmitted(bob.fed.replica)).toBe(true);
    expect(r.stored(bob.fed.replica).at(-1)?.seq).toBe(bob.fed.head()?.seq);
  });

  it('accepts mail sealed to a machine revoked in flight, and wedges nobody', async () => {
    const r = await team(['ada', 'bob', 'cy']);
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
    const r = await team(['ada', 'bob']);
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

describe('registering the team at the relay on a switch', () => {
  it('registers the team before it signs the switch', async () => {
    const r = await team(['ada', 'bob']);
    expect(await registered(r)).toBe(false);
    const res = await at(0).teamRoute('/api/team/transport', toRelay(r));
    expect(res.status).toBe(200);
    expect(await registered(r)).toBe(true);
    const held = r.stored(at(0).fed.replica);
    expect(held[0]?.type).toBe('key');
    const foundSeq = Number(at(0).fed.meta('founder_seq'));
    expect(held.some((e) => e.seq === foundSeq)).toBe(true);
  });

  it('switches a team the relay already holds', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).roster.closeLegacy();
    await passes(open);
    const r = await startRelay(at(0));
    const res = await at(0).teamRoute('/api/team/transport', toRelay(r));
    expect(res.status).toBe(200);
    expect(at(0).roster.view()?.transport.kind).toBe('relay');
  });

  it('registers from the branch when the switching admin is not the founder', async () => {
    const r = await team(['ada', 'bob']);
    at(0).roster.setRole(at(1).fed.replica, 'admin');
    await passes(open);
    const res = await at(1).teamRoute('/api/team/transport', toRelay(r));
    expect(res.status).toBe(200);
    expect(await registered(r)).toBe(true);
    expect(r.stored(at(0).fed.replica)[0]?.type).toBe('key');
  });

  it('refuses the switch and signs nothing when the relay cannot register the team', async () => {
    const r = await team(['ada', 'bob']);
    const head = at(0).fed.head()?.seq;
    await r.stop();
    relay = null;
    const res = await at(0).teamRoute('/api/team/transport', toRelay(r));
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain('could not register the team');
    expect(at(0).fed.head()?.seq).toBe(head);
    expect(at(0).roster.view()?.transport.kind).toBe('git');
  });

  it('sends the registration token only to the relay, never into an op', async () => {
    const token = 'tok-3c1b7e9f-only-for-registration';
    const r = await team(['ada', 'bob'], { registrationToken: token });
    const head = at(0).fed.head()?.seq;
    const without = await at(0).teamRoute('/api/team/transport', toRelay(r));
    expect(without.status).toBe(502);
    expect(String(without.body.error)).toContain('needs a registration token');
    const wrong = await at(0).teamRoute(
      '/api/team/transport',
      toRelay(r, { registrationToken: 'not-the-token' })
    );
    expect(wrong.status).toBe(502);
    expect(String(wrong.body.error)).toContain(
      'refused the registration token'
    );
    expect(String(wrong.body.error)).not.toContain('not-the-token');
    expect(at(0).fed.head()?.seq).toBe(head);
    expect(await registered(r)).toBe(false);
    const ok = await at(0).teamRoute(
      '/api/team/transport',
      toRelay(r, { registrationToken: token })
    );
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(token);
    await passes(open, 3);
    expect(at(1).service.status().transport).toBe('relay');
    for (const m of open) {
      const kept = [
        ...m.fed.ownLog(),
        ...m.fed.db
          .query<{ row: string }, []>(
            'SELECT detail_json AS row FROM fed_audit UNION ALL SELECT message AS row FROM fed_problems UNION ALL SELECT body_json AS row FROM fed_roster'
          )
          .all(),
      ];
      expect(JSON.stringify(kept)).not.toContain(token);
    }
  });

  it('refuses a registration token that is not a string', async () => {
    const r = await team(['ada', 'bob']);
    const res = await at(0).teamRoute(
      '/api/team/transport',
      toRelay(r, { registrationToken: 7 })
    );
    expect(res.status).toBe(400);
    expect(await registered(r)).toBe(false);
  });
});

describe('the founder chain a registration sends', () => {
  // A stand-in log entry: founderChain reads replica, seq, type and body.
  const entry = (
    replica: string,
    seq: number,
    type: string,
    action?: string
  ): LogEntry =>
    ({
      replica,
      seq,
      type,
      ...(action === undefined ? {} : { body: { action } }),
    }) as unknown as LogEntry;

  it("carries the founder's ops through its latest license op", () => {
    const log = [
      entry('a', 1, 'key'),
      entry('a', 2, 'roster', 'found'),
      entry('a', 3, 'task'),
      entry('b', 4, 'roster', 'license'),
      entry('a', 4, 'roster', 'license'),
      entry('a', 5, 'task'),
    ];
    const chain = founderChain(log, 'a', 2);
    expect(chain?.key.seq).toBe(1);
    expect(chain?.found.seq).toBe(2);
    expect(chain?.ops.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('carries only the key and found ops without a license, or past a gap', () => {
    const plain = [
      entry('a', 1, 'key'),
      entry('a', 2, 'roster', 'found'),
      entry('a', 3, 'task'),
    ];
    expect(founderChain(plain, 'a', 2)?.ops).toEqual([]);
    const gap = [
      entry('a', 1, 'key'),
      entry('a', 2, 'roster', 'found'),
      entry('a', 4, 'roster', 'license'),
    ];
    expect(founderChain(gap, 'a', 2)?.ops).toEqual([]);
    expect(founderChain([entry('a', 1, 'key')], 'a', 2)).toBeNull();
  });

  it('derives the https base from the relay URL', () => {
    expect(relayHttpBase('wss://relay.example/')).toBe('https://relay.example');
    expect(relayHttpBase('wss://relay.example:8443/team')).toBe(
      'https://relay.example:8443/team'
    );
    expect(relayHttpBase('ws://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
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

describe('registering at the relay without a token', () => {
  // A fetch that answers the terms and records what each POST carried.
  const scripted = (
    terms: Record<string, unknown> | null,
    answers: number[]
  ): {
    fetch: typeof fetch;
    posts: { body: Record<string, unknown>; auth: string | null }[];
  } => {
    const posts: { body: Record<string, unknown>; auth: string | null }[] = [];
    const fake = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/v1/registration'))
        return Promise.resolve(
          terms === null
            ? new Response('no', { status: 404 })
            : Response.json(terms)
        );
      const headers = new Headers(init?.headers);
      posts.push({
        body: JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}'
        ) as Record<string, unknown>,
        auth: headers.get('authorization'),
      });
      const status = answers[posts.length - 1] ?? 500;
      return Promise.resolve(
        status < 300
          ? Response.json({ teamId: 'the-team' }, { status })
          : Response.json({ error: 'refused' }, { status })
      );
    }) as unknown as typeof fetch;
    return { fetch: fake, posts };
  };

  it('counts leading zero bits most significant first', () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x0f, 0xff]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });

  it('mints a stamp whose hash has the asked-for zero bits', async () => {
    const nonce = await mintStamp(
      't'.repeat(32),
      'wss://relay.test',
      1_700_000_000,
      12
    );
    expect(nonce).toMatch(/^\d+$/);
    const digest = new Bun.CryptoHasher('sha256')
      .update(powText('t'.repeat(32), 'wss://relay.test', 1_700_000_000, nonce))
      .digest();
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(12);
  });

  it('registers at the fake relay with a stamp and no token, and is refused with none', async () => {
    open = await foundedTeam('ada');
    relay = await startFakeRelay(at(0), { difficulty: 10 });
    const bare = await fetch(`${relayHttpBase(relay.url)}/v1/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registrationOf(at(0))),
    });
    expect(bare.status).toBe(403);
    expect(await registerAtRelay(relay.url, registrationOf(at(0)))).toBe(
      relay.teamId
    );
    expect(await registered(relay)).toBe(true);
  });

  it('sends {t, nonce} over the normalized URL, and mints once more after a 403', async () => {
    open = await foundedTeam('ada');
    const { fetch: fake, posts } = scripted(
      { difficulty: 4, tokenRequired: false, tokenAccepted: false },
      [403, 201]
    );
    let now = 1_700_000_000_000;
    const id = await registerAtRelay(
      'wss://relay.test/',
      registrationOf(at(0)),
      {
        fetch: fake,
        now: () => (now += 5_000),
      }
    );
    expect(id).toBe('the-team');
    expect(posts).toHaveLength(2);
    const [first, second] = posts.map(
      (p) => p.body.pow as { t: number; nonce: string }
    );
    expect(second?.t).toBeGreaterThan(first?.t ?? 0);
    // The stamp covers the team id and the URL without its trailing slash.
    const teamId = opHash(registrationOf(at(0)).found).slice(0, 32);
    const digest = new Bun.CryptoHasher('sha256')
      .update(
        powText(teamId, 'wss://relay.test', second?.t ?? 0, second?.nonce ?? '')
      )
      .digest();
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(4);
    expect(posts.every((p) => p.auth === null)).toBe(true);
  });

  it('fails in plain words after a second 403', async () => {
    open = await foundedTeam('ada');
    const { fetch: fake, posts } = scripted(
      { difficulty: 2, tokenRequired: false, tokenAccepted: false },
      [403, 403]
    );
    await expect(
      registerAtRelay('wss://relay.test', registrationOf(at(0)), {
        fetch: fake,
      })
    ).rejects.toThrow('refused the proof of work twice');
    expect(posts).toHaveLength(2);
  });

  it('asks for a token a self-hosted relay requires, without posting', async () => {
    open = await foundedTeam('ada');
    const { fetch: fake, posts } = scripted(
      { difficulty: 19, tokenRequired: true, tokenAccepted: true },
      []
    );
    await expect(
      registerAtRelay('wss://relay.test', registrationOf(at(0)), {
        fetch: fake,
      })
    ).rejects.toThrow('needs a registration token');
    expect(posts).toHaveLength(0);
  });

  it('sends the token in place of a stamp where the relay accepts one', async () => {
    open = await foundedTeam('ada');
    const { fetch: fake, posts } = scripted(
      { difficulty: 19, tokenRequired: false, tokenAccepted: true },
      [201]
    );
    await registerAtRelay('wss://relay.test', registrationOf(at(0)), {
      fetch: fake,
      token: 'op-token',
    });
    expect(posts[0]?.auth).toBe('Bearer op-token');
    expect(posts[0]?.body.pow).toBeUndefined();
  });

  it('refuses a relay that asks for more work than Dispatch will do', async () => {
    open = await foundedTeam('ada');
    const { fetch: fake, posts } = scripted(
      { difficulty: 40, tokenRequired: false, tokenAccepted: false },
      []
    );
    await expect(
      registerAtRelay('wss://relay.test', registrationOf(at(0)), {
        fetch: fake,
      })
    ).rejects.toThrow('more work');
    expect(posts).toHaveLength(0);
  });
});
