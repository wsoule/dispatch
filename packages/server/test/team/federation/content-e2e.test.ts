import type { AgentRecord } from '@dispatch-foo/protocol';
import {
  b64u,
  decryptContent,
  fingerprint,
  generateContentKey,
  isContentEnvelope,
  isStub,
  runTag,
  stubOf,
} from '@dispatch-foo/protocol/federation';
import type {
  ContentEnvelope,
  ContentKeyGrant,
  FederatedOp,
  LogEntry,
} from '@dispatch-foo/protocol/federation';
import type { Principal } from '@dispatch/memory';
import { afterEach, describe, expect, it } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { ContentKeyMissingError } from '../../../src/team/federation/content.js';
import type { ContentE2eStatus } from '../../../src/team/federation/content.js';
import {
  RELAY_DISCLOSURE,
  RELAY_DISCLOSURE_E2E,
  relayDisclosure,
} from '../../../src/team/federation/teamKeys.js';
import { startFakeRelay } from './fakeRelay.js';
import type { FakeRelay } from './fakeRelay.js';
import {
  foundedTeamWith,
  messagingReplica,
} from './helpers/messagingReplica.js';
import type { MessagingReplica, TeamOpts } from './helpers/messagingReplica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

// Stage 2 of e2e team content: once an admin switches the team on, every
// content op goes out under the roster epoch's key, and keys travel only in
// sealed grants.
let open: MessagingReplica[] = [];
let relay: FakeRelay | null = null;
afterEach(async () => {
  for (const r of open) r.close();
  open = [];
  await relay?.stop();
  relay = null;
});
const at = (i: number): MessagingReplica => open[i];

const MARKER = 'zebra-marker-7f3a';
const human = (h: string): Principal => ({
  address: `human:${h}`,
  canDecide: true,
  kind: 'human',
});
const agent = (address: string): AgentRecord => ({
  address,
  displayName: `${MARKER} agent`,
  client: 'codex',
  tokenHash: 'a'.repeat(64),
  status: 'approved',
  muted: false,
  approvedBy: 'human:bob',
  createdAt: '2026-09-26T00:00:00.000Z',
});
// Each replica's pass, in turn, `n` times.
const passes = async (rs: MessagingReplica[], n = 2): Promise<void> => {
  for (let i = 0; i < n; i++) for (const r of rs) await r.service.syncNow();
};
const status = (r: MessagingReplica): ContentE2eStatus =>
  r.service.content.status();
const titles = (r: MessagingReplica): string[] =>
  r.store
    .list()
    .map((t) => t.meta.title)
    .sort();
const fp = (r: MessagingReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);
// What the transport holds of a replica's log.
const remoteLog = (r: MessagingReplica): LogEntry[] =>
  r.remote.logs.get(r.fed.replica) ?? [];

// A grant this machine sends, whatever the roster says it may send.
const plantGrant = (
  from: MessagingReplica,
  epoch: string,
  to: MessagingReplica
): void =>
  (
    from.service.content as unknown as {
      publishGrant(grant: ContentKeyGrant[], replicas: string[]): void;
    }
  ).publishGrant(
    [{ epoch, key: b64u(generateContentKey()) }],
    [to.fed.replica]
  );
// The grant ops a machine sent to `to`.
const grantsTo = (from: MessagingReplica, to: MessagingReplica): LogEntry[] =>
  remoteLog(from).filter(
    (e) => e.type === 'state' && (e.to ?? []).includes(to.fed.replica)
  );
const sameKey = (a: MessagingReplica, b: MessagingReplica, epoch: string) =>
  a.fed.keyring.get(epoch)?.equals(b.fed.keyring.get(epoch) ?? Buffer.alloc(0));

// A team with its legacy window closed and content switched to e2e.
async function e2eTeam(
  handles: string[],
  opts: TeamOpts = {}
): Promise<MessagingReplica[]> {
  open = await foundedTeamWith(
    { docs: true, withMemory: true, ...opts },
    ...handles
  );
  at(0).roster.closeLegacy();
  await passes(open);
  const on = await at(0).teamRoute('/api/team/content-e2e', {});
  expect(on.status).toBe(200);
  await passes(open, 3);
  return open;
}

// A machine that joins the team on `founder`'s remote after the switch.
async function lateJoiner(
  founder: MessagingReplica,
  handle: string
): Promise<MessagingReplica> {
  const late = messagingReplica(handle, founder.remote, new MemoryV1(), {
    docs: true,
    withMemory: true,
  });
  open.push(late);
  await passes([late, founder], 1);
  founder.roster.admit(late.fed.replica, { fingerprint: fp(late) });
  return late;
}

describe('e2e team content', () => {
  it('round-trips task, memory, doc, presence, agent and channel ops through a relay that holds no plaintext', async () => {
    open = await foundedTeamWith(
      { docs: true, withMemory: true },
      'ada',
      'bob',
      'cy'
    );
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    ada.roster.closeLegacy();
    await passes(open);
    relay = await startFakeRelay(ada);
    const r = relay;
    const switched = await ada.teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
      confirmed: true,
    });
    expect(switched.status).toBe(200);
    await passes(open, 3);
    expect(relayDisclosure(bob.roster.view())).toBe(RELAY_DISCLOSURE);
    const on = await ada.teamRoute('/api/team/content-e2e', {});
    expect(on.status).toBe(200);
    expect(on.body.on).toBe(true);
    expect(Date.parse(String(on.body.sinceAt))).not.toBeNaN();
    await passes(open, 3);
    expect(relayDisclosure(bob.roster.view())).toBe(RELAY_DISCLOSURE_E2E);
    for (const m of open) {
      expect(status(m).missing).toEqual([]);
      expect(status(m).epochs).toHaveLength(1);
    }
    // keys/content.json beside replica.json, owner-only.
    const file = join(bob.dir, 'keys', 'content.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Ops from before the switch stay as they were published.
    const heads = new Map(
      open.map((m) => [m.fed.replica, m.fed.head()?.seq ?? 0])
    );
    const task = bob.store.create({ title: `${MARKER} task` });
    bob.store.update(task.meta.id, { body: MARKER });
    const saved = await bob.memory?.engine.save(human('bob'), {
      scope: 'team',
      kind: 'fact',
      title: `${MARKER} fact`,
      body: `${MARKER} body`,
    });
    bob.docs?.port.pending.push({ doc: 'doc-1', kind: 'put', n: 7 });
    bob.messages.putAgent(agent('agent:bob/codex'));
    bob.engine.join(`${MARKER}-ops`, 'human:bob');
    bob.startRun({ id: 'r-00000000c0de', taskId: task.meta.id });
    await passes(open, 4);

    for (const m of [ada, cy]) {
      expect(m.store.get(task.meta.id)?.meta.title).toBe(`${MARKER} task`);
      const id = saved?.status === 'active' ? saved.id : '';
      expect(m.memory?.shared.getEntry(id)?.title).toBe(`${MARKER} fact`);
      expect(m.docs?.port.seen.some((s) => s.n === 7)).toBe(true);
      expect(m.messages.getAgent('agent:bob/codex')).not.toBeNull();
      expect(m.messages.members(`${MARKER}-ops`)).toContain('human:bob');
      expect(
        m.fed.db
          .query<{ task: string | null }, [string]>(
            'SELECT task FROM fed_runs WHERE run = ?'
          )
          .get('r-00000000c0de')?.task
      ).toBe(task.meta.id);
    }
    // The relay holds every content op as an envelope, and no plaintext.
    for (const m of open) {
      const stored = r.stored(m.fed.replica);
      expect(JSON.stringify(stored)).not.toContain(MARKER);
      const content = stored.filter(
        (e): e is FederatedOp =>
          !isStub(e) &&
          e.seq > (heads.get(m.fed.replica) ?? 0) &&
          ['task', 'memory', 'doc', 'agent', 'channel', 'presence'].includes(
            e.type
          )
      );
      for (const e of content) expect(isContentEnvelope(e.body)).toBe(true);
    }
    expect(r.stored(bob.fed.replica).map((e) => e.type)).toEqual(
      expect.arrayContaining(['task', 'memory', 'doc', 'agent', 'channel'])
    );
  });

  it('keeps relay retention per run with tagged run ids', async () => {
    open = await foundedTeamWith({}, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    ada.roster.closeLegacy();
    await passes(open);
    relay = await startFakeRelay(ada);
    const r = relay;
    await ada.teamRoute('/api/team/transport', {
      kind: 'relay',
      url: r.url,
      confirmed: true,
    });
    await passes(open, 3);
    await ada.teamRoute('/api/team/content-e2e', {});
    await passes(open, 3);
    bob.startRun({ id: 'r-0000000000a1', taskId: null });
    bob.host.auxRuns.delete('r-0000000000a1');
    bob.presence.runEnded({ id: 'r-0000000000a1', taskId: null });
    bob.startRun({ id: 'r-0000000000a2', taskId: null });
    await passes(open, 3);
    const key = bob.fed.keyring.get(status(bob).current ?? '');
    if (key === null) throw new Error('bob holds no key');
    const runs = r
      .stored(bob.fed.replica)
      .filter((e): e is FederatedOp => e.type === 'presence' && !isStub(e))
      .map((e) => e.body as unknown as ContentEnvelope)
      .filter((b) => b.kind === 'run');
    // Only the latest op per run stays whole, each under its run's tag.
    const byText = (a = '', b = ''): number => a.localeCompare(b);
    expect(runs.map((b) => b.run).sort(byText)).toEqual(
      [runTag(key, 'r-0000000000a1'), runTag(key, 'r-0000000000a2')].sort(
        byText
      )
    );
    expect(JSON.stringify(r.stored(bob.fed.replica))).not.toContain(
      'r-0000000000a1'
    );
    expect(
      ada.fed.db
        .query<{ replica: string }, [string]>(
          'SELECT replica FROM fed_runs WHERE run = ?'
        )
        .get('r-0000000000a2')?.replica
    ).toBe(bob.fed.replica);
  });

  it('refuses the switch for a member, while the legacy window is open, or while a machine lacks the cap', async () => {
    open = await foundedTeamWith(
      { capsFor: { cy: ['relay'] } },
      'ada',
      'bob',
      'cy'
    );
    const [ada, bob] = [at(0), at(1)];
    const legacy = await ada.teamRoute('/api/team/content-e2e', {});
    expect(legacy.status).toBe(409);
    expect(legacy.body.error).toContain('legacy window');
    ada.roster.closeLegacy();
    await passes(open);
    const lacking = await ada.teamRoute('/api/team/content-e2e', {});
    expect(lacking.status).toBe(409);
    expect(lacking.body.error).toContain('cy');
    expect(status(ada).lacking.map((l) => l.handle)).toEqual(['cy']);
    const member = await bob.teamRoute('/api/team/content-e2e', {});
    expect(member.status).toBe(403);
    at(2).setCaps(['relay', 'content-e2e']);
    await passes(open, 2);
    expect((await ada.teamRoute('/api/team/content-e2e', {})).status).toBe(200);
    const again = await ada.teamRoute('/api/team/content-e2e', {});
    expect(again.status).toBe(409);
  });

  it('leaves bodies plain while the team is off', async () => {
    open = await foundedTeamWith({}, 'ada', 'bob');
    const task = at(1).store.create({ title: 'plain' });
    await passes(open);
    const op = remoteLog(at(1)).find((e) => e.type === 'task') as FederatedOp;
    expect((op.body as { task?: string }).task).toBe(task.meta.id);
    expect(status(at(0))).toMatchObject({ on: false, epochs: [], missing: [] });
  });

  it('lets a machine admitted later read the whole history', async () => {
    await e2eTeam(['ada', 'bob']);
    const [ada, bob] = [at(0), at(1)];
    const task = bob.store.create({ title: 'before dan' });
    await passes(open, 2);
    const dan = await lateJoiner(ada, 'dan');
    await passes(open, 4);
    expect(status(dan).missing).toEqual([]);
    expect(dan.store.get(task.meta.id)?.meta.title).toBe('before dan');
    dan.store.create({ title: 'from dan' });
    await passes(open, 2);
    expect(titles(bob)).toContain('from dan');
  });

  it('opens a new epoch on a revoke that the revoked machine cannot read', async () => {
    await e2eTeam(['ada', 'bob', 'cy']);
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const first = status(ada).current;
    ada.roster.revoke(cy.fed.replica, 'left');
    await passes(open, 3);
    const epochs = status(bob).epochs.map((e) => e.epoch);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]).toBe(first ?? '');
    expect(status(bob).missing).toEqual([]);
    expect(status(cy).missing).toEqual([epochs[1]]);
    const task = bob.store.create({ title: `${MARKER} after cy` });
    await passes(open, 2);
    expect(ada.store.get(task.meta.id)?.meta.title).toBe(`${MARKER} after cy`);
    expect(cy.store.get(task.meta.id)).toBeNull();
    // No key cy holds opens it.
    const op = remoteLog(bob).find(
      (e): e is FederatedOp =>
        e.type === 'task' &&
        !isStub(e) &&
        (e.body as unknown as ContentEnvelope).epoch === epochs[1]
    );
    if (op === undefined) throw new Error('no task op under the new epoch');
    for (const epoch of epochs) {
      const key = cy.fed.keyring.get(epoch);
      if (key !== null) expect(() => decryptContent(op, key)).toThrow();
    }
  });

  it('parks an op whose epoch key is missing and applies it once a grant lands', async () => {
    await e2eTeam(['ada', 'bob']);
    const [ada, bob] = [at(0), at(1)];
    const task = bob.store.create({ title: 'waits for the key' });
    await passes(open, 2);
    const dan = await lateJoiner(ada, 'dan');
    // Ada's grant to dan is on no file dan's pull reaches yet.
    await passes([ada], 1);
    const grants = remoteLog(ada).filter(
      (e) => e.type === 'state' && (e.to ?? []).includes(dan.fed.replica)
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) dan.remote.hidden.add(g);
    await passes([dan], 2);
    expect(dan.store.get(task.meta.id)).toBeNull();
    const parked = dan.fed.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM fed_parked WHERE reason = 'key'"
      )
      .get()?.n;
    expect(parked).toBeGreaterThan(0);
    // Without the key, a local write is refused before it is made.
    expect(() => dan.store.create({ title: 'too soon' })).toThrow(
      ContentKeyMissingError
    );
    for (const g of grants) dan.remote.hidden.delete(g);
    await passes([dan], 2);
    expect(dan.store.get(task.meta.id)?.meta.title).toBe('waits for the key');
    expect(
      dan.fed.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_parked')
        .get()?.n
    ).toBe(0);
  });

  it('recovers a pruned grant through wants on presence', async () => {
    await e2eTeam(['ada', 'bob']);
    const [ada, bob] = [at(0), at(1)];
    const task = bob.store.create({ title: 'behind a pruned grant' });
    await passes(open, 2);
    const dan = await lateJoiner(ada, 'dan');
    await passes([ada], 1);
    // Every grant to dan is pruned before dan reads it.
    for (const g of remoteLog(ada))
      if (g.type === 'state' && (g.to ?? []).includes(dan.fed.replica))
        ada.remote.tamper(ada.fed.replica, g.seq, (e) =>
          isStub(e) ? e : stubOf(e)
        );
    await passes([dan], 2);
    expect(status(dan).missing).toHaveLength(1);
    // Dan's replica presence asks for the epoch in the clear.
    const asks = remoteLog(dan).filter(
      (e): e is FederatedOp =>
        e.type === 'presence' &&
        !isStub(e) &&
        ((e.body as unknown as ContentEnvelope).wants ?? []).length > 0
    );
    expect(asks.length).toBeGreaterThan(0);
    await passes([ada, bob, dan], 3);
    expect(status(dan).missing).toEqual([]);
    expect(dan.store.get(task.meta.id)?.meta.title).toBe(
      'behind a pruned grant'
    );
  });

  it('drops a presence whose clear hints do not match its content', async () => {
    await e2eTeam(['ada', 'bob']);
    const [ada, bob] = [at(0), at(1)];
    const real = bob.service.content;
    bob.fed.setContentSealer({
      current: () => real.current(),
      missing: () => real.missing(),
      wants: () => real.wants(),
      seal: (op) => {
        const sealed = real.seal(op) as unknown as ContentEnvelope;
        return { ...sealed, kind: 'replica' } as never;
      },
    });
    bob.startRun({ id: 'r-0000000000a3', taskId: null });
    bob.fed.setContentSealer(real);
    await passes(open, 2);
    expect(
      ada.fed
        .problems()
        .find((p) => p.subject === `malformed:${bob.fed.replica}`)?.message
    ).toContain('clear hints do not match');
    expect(
      ada.fed.db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM fed_runs WHERE run = ?'
        )
        .get('r-0000000000a3')?.n
    ).toBe(0);
  });

  // An observer reads the board today, so it holds the team's keys; it
  // publishes only presence, and never grants.
  it('grants an observer the keys, which reads content but grants none', async () => {
    await e2eTeam(['ada', 'bob', 'cy'], { observers: ['cy'] });
    const [, bob, cy] = [at(0), at(1), at(2)];
    expect(status(cy).missing).toEqual([]);
    const task = bob.store.create({ title: 'seen by the observer' });
    await passes(open, 2);
    expect(cy.store.get(task.meta.id)?.meta.title).toBe('seen by the observer');
    expect(remoteLog(cy).some((e) => e.type === 'state')).toBe(false);
  });

  it('ignores a key from a member that neither opened its epoch nor admits', async () => {
    await e2eTeam(['ada', 'cy']);
    const [ada, cy] = [at(0), at(1)];
    const task = cy.store.create({ title: 'behind the real key' });
    await passes(open, 2);
    const epoch = status(ada).current ?? '';
    const dan = await lateJoiner(ada, 'dan');
    await passes([ada], 1);
    const real = grantsTo(ada, dan);
    expect(real.length).toBeGreaterThan(0);
    for (const g of real) dan.remote.hidden.add(g);
    // Dan asks for the key; cy, a member, answers no wants.
    await passes([dan, cy], 2);
    expect(grantsTo(cy, dan)).toEqual([]);
    plantGrant(cy, epoch, dan);
    await passes([cy, dan], 2);
    expect(grantsTo(cy, dan).length).toBeGreaterThan(0);
    expect(status(dan).missing).toEqual([epoch]);
    expect(dan.store.get(task.meta.id)).toBeNull();
    for (const g of real) dan.remote.hidden.delete(g);
    await passes([dan], 2);
    expect(status(dan).missing).toEqual([]);
    expect(sameKey(dan, ada, epoch)).toBe(true);
    expect(dan.store.get(task.meta.id)?.meta.title).toBe('behind the real key');
  });

  it('takes a key from an admin that did not open its epoch', async () => {
    await e2eTeam(['ada', 'bob'], { admins: ['bob'] });
    const [ada, bob] = [at(0), at(1)];
    const epoch = status(ada).current ?? '';
    const dan = await lateJoiner(ada, 'dan');
    await passes([ada], 1);
    for (const g of grantsTo(ada, dan)) dan.remote.hidden.add(g);
    await passes([dan, bob], 3);
    expect(grantsTo(bob, dan).length).toBeGreaterThan(0);
    await passes([dan], 1);
    expect(status(dan).missing).toEqual([]);
    expect(sameKey(dan, ada, epoch)).toBe(true);
  });

  it("prefers the opener's key over an admin's conflicting one, and says so", async () => {
    await e2eTeam(['ada', 'bob'], { admins: ['bob'] });
    const [ada, bob] = [at(0), at(1)];
    const epoch = status(ada).current ?? '';
    const dan = await lateJoiner(ada, 'dan');
    await passes([ada], 1);
    const real = grantsTo(ada, dan);
    for (const g of real) dan.remote.hidden.add(g);
    await passes([bob], 1);
    // Bob, an admin, sends dan a key of its own before dan has asked.
    plantGrant(bob, epoch, dan);
    await passes([bob, dan], 1);
    expect(sameKey(dan, ada, epoch)).toBe(false);
    for (const g of real) dan.remote.hidden.delete(g);
    await passes([dan], 1);
    expect(sameKey(dan, ada, epoch)).toBe(true);
    expect(
      dan.fed.problems().find((p) => p.subject.startsWith('content:conflict:'))
        ?.message
    ).toContain('opened that epoch');
  });

  it('drops plain content stamped after the switch, and keeps plain history from before it', async () => {
    open = await foundedTeamWith(
      { docs: true, withMemory: true },
      'ada',
      'bob'
    );
    const [ada, bob] = [at(0), at(1)];
    ada.roster.closeLegacy();
    const before = bob.store.create({ title: 'plain before' });
    await passes(open);
    expect((await ada.teamRoute('/api/team/content-e2e', {})).status).toBe(200);
    await passes(open, 3);
    // Bob's build sends a task in the clear after the switch.
    const real = bob.service.content;
    bob.fed.setContentSealer({
      current: () => real.current(),
      missing: () => real.missing(),
      wants: () => real.wants(),
      seal: (op) => op.body,
    });
    const after = bob.store.create({ title: 'plain after' });
    bob.fed.setContentSealer(real);
    await passes(open, 2);
    const sent = remoteLog(bob).find(
      (e): e is FederatedOp =>
        e.type === 'task' &&
        !isStub(e) &&
        (e.body as { task?: string }).task === after.meta.id
    );
    expect(sent).toBeDefined();
    expect(ada.store.get(after.meta.id)).toBeNull();
    expect(
      ada.fed
        .problems()
        .find((p) => p.subject === `malformed:${bob.fed.replica}`)?.message
    ).toContain('plain content sent after the team switched');
    // A machine admitted later still reads the plain history.
    const dan = await lateJoiner(ada, 'dan');
    await passes(open, 4);
    expect(dan.store.get(before.meta.id)?.meta.title).toBe('plain before');
    expect(dan.store.get(after.meta.id)).toBeNull();
  });

  it('lets in no machine whose build cannot read e2e content, and says why', async () => {
    await e2eTeam(['ada', 'bob']);
    const ada = at(0);
    const dan = messagingReplica('dan', ada.remote, new MemoryV1(), {
      docs: true,
      withMemory: true,
      capsFor: { dan: ['relay'] },
    });
    open.push(dan);
    const { code } = ada.roster.invite('dan');
    await passes([ada], 1);
    dan.roster.join(code);
    await passes([dan, ada], 2);
    expect(ada.roster.view()?.members.has(dan.fed.replica)).toBe(false);
    expect(
      ada.fed.problems().find((p) => p.subject.startsWith('invite:'))?.message
    ).toContain('does not speak end-to-end encrypted team content');
    const manual = await ada.teamRoute(
      `/api/team/keys/${dan.fed.replica}/admit`,
      { fingerprint: fp(dan) }
    );
    expect(manual.status).toBe(409);
    expect(String(manual.body.error)).toContain('end-to-end');
  });
});
