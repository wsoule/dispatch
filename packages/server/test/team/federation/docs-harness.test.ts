import { afterEach, describe, expect, it } from 'bun:test';

import type { Member } from './harness/cluster.js';
import { cluster, quiesce } from './harness/cluster.js';

// Team docs over signed doc ops, end to end: real daemons over one bare
// remote (docs plan Task 20; spec Testing "v2 sync").

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function team(names: string[]): Promise<Member[]> {
  const c = await cluster(names);
  stop = c.stop;
  const [founder, ...rest] = c.members as [Member, ...Member[]];
  await founder.handle.found();
  await quiesce(c.members);
  for (const m of rest) await founder.handle.admit(m.handle);
  await quiesce(c.members);
  return c.members;
}

type Body = Record<string, unknown>;
const docs = async (
  m: Member,
  path: string,
  body?: unknown,
  token?: string
): Promise<Body> =>
  ((
    await m.handle.api(
      `/api/docs${path}`,
      body === undefined
        ? { token }
        : { method: 'POST', body: JSON.stringify(body), token }
    )
  ).body ?? {}) as Body;
const text = async (m: Member, ref: string): Promise<string> =>
  (await docs(m, `/${ref}`)).text as string;
const edit = async (
  m: Member,
  ref: string,
  find: string,
  to: string,
  token?: string
): Promise<void> => {
  await docs(
    m,
    `/${ref}/edit`,
    { ops: [{ op: 'replace', find, text: to }] },
    token
  );
  await docs(m, `/${ref}/seal`, {}, token);
};

// What must be identical on every replica: ids, handles, head ids and bytes, flags.
async function teamDocs(m: Member): Promise<unknown> {
  const list = (await docs(m, '?scope=team&includeArchived=1&limit=100'))
    .docs as {
    id: string;
    handle: string;
    status: string;
    conflicted: boolean;
    head: { id: string; hash: string };
  }[];
  return list
    .map((d) => ({
      id: d.id,
      handle: d.handle,
      status: d.status,
      conflicted: d.conflicted,
      head: d.head.id,
      hash: d.head.hash,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
async function expectDocsConverged(members: Member[]): Promise<void> {
  const [first, ...rest] = await Promise.all(members.map(teamDocs));
  for (const other of rest) expect(other).toEqual(first);
}
async function syncMerges(m: Member, ref: string): Promise<string[]> {
  const { revisions } = (await docs(m, `/${ref}/revisions?limit=100`)) as {
    revisions: { id: string; cause: string }[];
  };
  return revisions
    .filter((r) => r.cause === 'sync')
    .map((r) => r.id)
    .sort();
}
const BODY = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n';
async function sharedSpec(members: Member[], accepted = false): Promise<void> {
  await docs(members[0], '', { title: 'Spec', body: BODY });
  await docs(members[0], '/spec/seal', {});
  if (accepted) await docs(members[0], '/spec/status', { status: 'accepted' });
  await quiesce(members);
}

describe('team docs over signed doc ops', () => {
  it('converges three replicas edited while apart to one head id and bytes, publishing every merge', async () => {
    const members = await team(['ada', 'bob', 'cy']);
    const [ada, bob, cy] = members as [Member, Member, Member];
    await sharedSpec(members);
    for (const m of members) m.handle.partition(true);
    await edit(ada, 'spec', 'l1\n', 'L1\n');
    await edit(bob, 'spec', 'l5\n', 'L5\n');
    await edit(cy, 'spec', 'l9\n', 'L9\n');
    for (const m of members) m.handle.partition(false);
    await quiesce(members);
    await expectDocsConverged(members);
    expect(await text(bob, 'spec')).toBe(
      'L1\nl2\nl3\nl4\nL5\nl6\nl7\nl8\nL9\n'
    );
    const merges = await Promise.all(members.map((m) => syncMerges(m, 'spec')));
    expect(merges[0].length).toBeGreaterThan(0);
    for (const other of merges.slice(1)) expect(other).toEqual(merges[0]);
  }, 180_000);

  it('flags a real conflict everywhere, with identical marked bytes', async () => {
    const members = await team(['ada', 'bob']);
    const [ada, bob] = members as [Member, Member];
    await sharedSpec(members);
    for (const m of members) m.handle.partition(true);
    await edit(ada, 'spec', 'l2\n', 'ADA\n');
    await edit(bob, 'spec', 'l2\n', 'BOB\n');
    for (const m of members) m.handle.partition(false);
    await quiesce(members);
    await expectDocsConverged(members);
    expect(
      ((await docs(ada, '/spec')).doc as { conflicted: boolean }).conflicted
    ).toBe(true);
    expect(await text(ada, 'spec')).toMatch(/^l1\n<<<<<<< rev-/);
  }, 180_000);

  it("holds back a run's edit made while the doc was being accepted elsewhere, until a human there decides", async () => {
    const members = await team(['ada', 'bob']);
    const [ada, bob] = members as [Member, Member];
    await sharedSpec(members);
    const task = await bob.handle.create('bob work');
    const { token } = await bob.handle.startRun(task);
    for (const m of members) m.handle.partition(true);
    await docs(ada, '/spec/status', { status: 'accepted' });
    await edit(bob, 'spec', 'l3\n', 'RUN\n', token);
    for (const m of members) m.handle.partition(false);
    await quiesce(members);
    expect(await text(ada, 'spec')).toBe(BODY);
    const [gate] = await ada.handle.openDecisions();
    expect(gate).toBeDefined();
    await ada.handle.reply(gate ?? '', { choice: 'approve', body: '' });
    await quiesce(members);
    await expectDocsConverged(members);
    expect(await text(ada, 'spec')).toContain('RUN\n');
  }, 180_000);

  it('holds back a policy approval this replica would not grant, and a reject here removes the change for everyone', async () => {
    const members = await team(['ada', 'bob']);
    const [ada, bob] = members as [Member, Member];
    await sharedSpec(members, true);
    await bob.handle.api('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({ policy: { rung: 4 } }),
    });
    const task = await bob.handle.create('routine bob work');
    const { token } = await bob.handle.startRun(task);
    await docs(
      bob,
      '/spec/edit',
      { ops: [{ op: 'replace', find: 'l4\n', text: 'AUTO\n' }] },
      token
    );
    expect(await text(bob, 'spec')).toContain('AUTO\n');
    await quiesce(members);
    expect(await text(ada, 'spec')).toBe(BODY);
    const [gate] = await ada.handle.openDecisions();
    await ada.handle.reply(gate ?? '', {
      choice: 'reject',
      body: 'not at rung 3 here',
    });
    await quiesce(members);
    await expectDocsConverged(members);
    expect(await text(bob, 'spec')).toBe(BODY);
  }, 180_000);

  it('converges a concurrent approve on one replica and reject on another on the reject', async () => {
    const members = await team(['ada', 'bob', 'cy']);
    const [ada, bob, cy] = members as [Member, Member, Member];
    await sharedSpec(members);
    const task = await bob.handle.create('bob work');
    const { token } = await bob.handle.startRun(task);
    for (const m of members) m.handle.partition(true);
    await docs(ada, '/spec/status', { status: 'accepted' });
    await edit(bob, 'spec', 'l6\n', 'RUN\n', token);
    bob.handle.partition(false);
    ada.handle.partition(false);
    await quiesce([ada, bob]);
    cy.handle.partition(false);
    await quiesce(members);
    const [adaGate] = await ada.handle.openDecisions();
    const [cyGate] = await cy.handle.openDecisions();
    for (const m of members) m.handle.partition(true);
    await ada.handle.reply(adaGate ?? '', { choice: 'approve', body: '' });
    await cy.handle.reply(cyGate ?? '', { choice: 'reject', body: 'no' });
    for (const m of members) m.handle.partition(false);
    await quiesce(members);
    await expectDocsConverged(members);
    expect(await text(ada, 'spec')).not.toContain('RUN\n');
  }, 240_000);

  it('revives a doc removed on one replica when another made a later revision', async () => {
    const members = await team(['ada', 'bob']);
    const [ada, bob] = members as [Member, Member];
    await sharedSpec(members);
    const id = ((await docs(ada, '/spec')).doc as { id: string }).id;
    for (const m of members) m.handle.partition(true);
    await ada.handle.api(`/api/docs/${id}`, { method: 'DELETE' });
    bob.clock.ms += 60_000;
    await edit(bob, 'spec', 'l7\n', 'LATER\n');
    for (const m of members) m.handle.partition(false);
    await quiesce(members);
    await expectDocsConverged(members);
    expect(await text(ada, 'spec')).toContain('LATER\n');
  }, 180_000);

  it('resolves concurrent creates claiming one slug to the same handles everywhere', async () => {
    const members = await team(['ada', 'bob']);
    const [ada, bob] = members as [Member, Member];
    for (const m of members) m.handle.partition(true);
    await docs(ada, '', { title: 'Spec', body: 'ada\n' });
    await docs(bob, '', { title: 'Spec', body: 'bob\n' });
    for (const m of members) {
      await docs(m, '/spec/seal', {});
      m.handle.partition(false);
    }
    await quiesce(members);
    await expectDocsConverged(members);
    const handles = ((await teamDocs(ada)) as { handle: string }[])
      .map((d) => d.handle)
      .sort();
    expect(handles[0]).toBe('spec');
    expect(handles[1]).toMatch(/^spec-[0-9a-z]{6}$/);
    expect(await teamDocs(bob)).toEqual(await teamDocs(ada));
  }, 180_000);

  it('never publishes a personal doc', async () => {
    const members = await team(['ada', 'bob']);
    const [ada, bob] = members as [Member, Member];
    const mine = await docs(ada, '', {
      title: 'Private plan',
      body: 'zanzibar\n',
      scope: 'personal',
    });
    await docs(ada, '/~private-plan/seal', {});
    await quiesce(members);
    expect(
      (await bob.handle.api(`/api/docs/${(mine.doc as { id: string }).id}`))
        .status
    ).toBe(404);
    expect(JSON.stringify(await docs(bob, '/search?q=zanzibar'))).not.toContain(
      'zanzibar'
    );
  }, 180_000);
});
