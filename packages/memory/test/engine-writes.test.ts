import { DEFAULT_MEMORY } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import { MemoryEngine } from '../src/engine.js';
import { MemoryError } from '../src/errors.js';
import type { Principal } from '../src/types.js';
import { ADA, FakeMemoryHost, fakeStores, OWNER, RUN } from './fakeHost.js';

const NO_OP_RUN: Principal = {
  address: 'run:r-000002',
  canDecide: false,
  kind: 'run',
};
const ADA_LOW: Principal = { ...ADA, canDecide: false };

function setup(overrides: Partial<typeof DEFAULT_MEMORY> = {}) {
  const host = new FakeMemoryHost();
  host.runTasks.set('r-9f2c01', 't-1a2b3c');
  host.operators.set('run:r-9f2c01', { human: 'human:wyat', identity: 'self' });
  host.operators.set('human:wyat', { human: 'human:wyat', identity: 'self' });
  host.operators.set('human:ada', { human: 'human:ada', identity: 'pid-A' });
  const s = fakeStores();
  const engine = new MemoryEngine({
    stores: s.stores,
    host,
    config: () => ({ ...DEFAULT_MEMORY, ...overrides }),
  });
  return { engine, host, ...s };
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    if (err instanceof MemoryError) return err.code;
    throw err;
  }
  return 'ok';
}

const hazard = {
  scope: 'personal',
  kind: 'fact',
  title: 'proto shims live in ~/.proto/shims',
  body: 'export PATH first',
} as const;

describe('personal writes', () => {
  it('a run writes its operator’s store with agent trust, logs activity and announces no id', async () => {
    const t = setup();
    const out = await t.engine.save(RUN, hazard);
    expect(out.status).toBe('active');
    const entry = t.stores
      .personal('self')
      .getEntry((out as { id: string }).id)!;
    expect(entry).toMatchObject({
      trust: 'agent',
      author: 'run:r-9f2c01',
      scope: 'personal',
      projectKey: null,
    });
    expect(
      t.engine
        .activity(OWNER, '1970-01-01T00:00:00.000Z')
        .map((a) => [a.kind, a.summary])
    ).toEqual([
      ['saved', `run:r-9f2c01 saved to your memory: ${hazard.title}`],
    ]);
    expect(t.host.changes).toEqual([{ scope: 'personal' }]);
  });

  it('a human writes with human trust; projectOnly narrows to this project', async () => {
    const t = setup();
    const out = await t.engine.save(OWNER, { ...hazard, projectOnly: true });
    expect(
      t.stores.personal('self').getEntry((out as { id: string }).id)
    ).toMatchObject({ trust: 'human', projectKey: 'aaaaaaaaaaaa' });
  });

  // The desktop Inbox reverses this order and offers Undo on each entry's last row.
  it('lists the operator’s activity oldest first', async () => {
    const t = setup();
    const e = (await t.engine.save(RUN, hazard)) as { id: string };
    await t.engine.edit(RUN, e.id, { body: 'v2', cause: 'ingest' });
    expect(
      t.engine.activity(OWNER, '1970-01-01T00:00:00.000Z').map((a) => a.kind)
    ).toEqual(['saved', 'ingested']);
  });

  it('refuses a run with no operator', async () => {
    const t = setup();
    expect(await code(t.engine.save(NO_OP_RUN, hazard))).toBe('forbidden');
  });

  it('limits runs to personalWritesPerHour and tells the operator once', async () => {
    const t = setup({ personalWritesPerHour: 2 });
    await t.engine.save(RUN, { ...hazard, title: 'one' });
    await t.engine.save(RUN, { ...hazard, title: 'two' });
    expect(await code(t.engine.save(RUN, { ...hazard, title: 'three' }))).toBe(
      'limited'
    );
    expect(await code(t.engine.save(RUN, { ...hazard, title: 'four' }))).toBe(
      'limited'
    );
    expect(
      t.engine
        .activity(OWNER, '1970-01-01T00:00:00.000Z')
        .filter((a) => a.kind === 'throttled')
    ).toHaveLength(1);
    expect(
      await code(
        t.engine.save(OWNER, { ...hazard, title: 'humans are not limited' })
      )
    ).toBe('ok');
  });

  it('counts a run’s forgets against personalWritesPerHour', async () => {
    const t = setup({ personalWritesPerHour: 2 });
    const [a, b] = (await Promise.all(
      ['a', 'b'].map((title) => t.engine.save(OWNER, { ...hazard, title }))
    )) as { id: string }[];
    await t.engine.save(RUN, { ...hazard, title: 'one' });
    expect(await code(t.engine.forget(RUN, a.id, 'stale'))).toBe('ok');
    expect(await code(t.engine.forget(RUN, b.id, 'stale'))).toBe('limited');
    expect(
      t.engine
        .activity(OWNER, '1970-01-01T00:00:00.000Z')
        .filter((x) => x.kind === 'throttled')
    ).toHaveLength(1);
  });

  it('supersedes within personal scope only', async () => {
    const t = setup();
    const first = (await t.engine.save(OWNER, hazard)) as { id: string };
    const second = (await t.engine.save(RUN, {
      ...hazard,
      title: 'proto shims: symlink ~/.proto/bin/proto',
      supersedes: first.id,
    })) as { id: string };
    const store = t.stores.personal('self');
    expect(store.getEntry(first.id)).toMatchObject({
      status: 'retired',
      statusReason: 'superseded',
      supersededBy: second.id,
    });
    // The target is looked up among every store the writer can see, so naming a
    // team entry from a personal write is `invalid` (wrong scope), not `not-found`.
    const team = (await t.engine.save(OWNER, {
      ...hazard,
      scope: 'team',
      kind: 'hazard',
    })) as { id: string };
    expect(
      await code(t.engine.save(OWNER, { ...hazard, supersedes: team.id }))
    ).toBe('invalid');
    expect(
      await code(
        t.engine.save(OWNER, { ...hazard, supersedes: `mem-${'Z'.repeat(26)}` })
      )
    ).toBe('not-found');
  });

  it('an agent edit of a human entry becomes agent trust; a stale base still wins and says whom it replaced', async () => {
    const t = setup();
    const e = (await t.engine.save(OWNER, hazard)) as { id: string };
    await t.engine.edit(OWNER, e.id, { body: 'human edit' });
    await t.engine.edit(RUN, e.id, {
      body: 'agent edit',
      baseRev: 1,
      cause: 'ingest',
    });
    expect(t.stores.personal('self').getEntry(e.id)).toMatchObject({
      body: 'agent edit',
      trust: 'agent',
      rev: 3,
    });
    expect(
      t.engine.activity(OWNER, '1970-01-01T00:00:00.000Z').at(-1)?.summary
    ).toContain('replaced a change by human:wyat');
  });

  it('forget, then undo by the entry’s human; runs cannot undo', async () => {
    const t = setup();
    const e = (await t.engine.save(RUN, hazard)) as {
      id: string;
      handle: string;
    };
    expect(await t.engine.forget(RUN, e.id, 'wrong machine')).toEqual({
      status: 'retired',
      id: e.id,
      handle: e.handle,
    });
    expect(await code(() => t.engine.undo(RUN, e.id))).toBe('forbidden');
    expect(t.engine.undo(OWNER, e.id)).toMatchObject({
      status: 'active',
      rev: 3,
    });
    const fresh = (await t.engine.save(RUN, {
      ...hazard,
      title: 'undo me',
    })) as { id: string };
    expect(t.engine.undo(OWNER, fresh.id)).toMatchObject({
      status: 'retired',
      statusReason: 'undone',
    });
  });

  // A decide-tier human is refused another human's personal entry.
  it('keeps lifecycle ops on a personal entry with its own human', async () => {
    const t = setup();
    const e = (await t.engine.save(RUN, hazard)) as { id: string };
    expect(t.engine.confirm(OWNER, e.id)).toMatchObject({ trust: 'confirmed' });
    expect(t.engine.setPinned(OWNER, e.id, true)).toMatchObject({
      pinned: true,
    });
    expect(await code(() => t.engine.confirm(ADA, e.id))).toBe('forbidden');
    expect(await code(() => t.engine.hardDelete(ADA, e.id))).toBe('forbidden');
    expect(t.engine.activity(ADA, '1970-01-01T00:00:00.000Z')).toEqual([]);
    t.engine.hardDelete(OWNER, e.id);
    expect(t.stores.personal('self').getEntry(e.id)).toBeNull();
  });
});

describe('shared writes', () => {
  it('a decide-tier human writes team memory directly with human trust', async () => {
    const t = setup();
    const out = (await t.engine.save(OWNER, {
      scope: 'team',
      kind: 'hazard',
      title: 'flaky server tests',
      body: 'run in chunks',
    })) as { id: string };
    expect(t.shared.getEntry(out.id)).toMatchObject({
      trust: 'human',
      author: 'human:wyat',
      scope: 'team',
    });
    expect(t.host.changes).toContainEqual({ scope: 'team', id: out.id });
  });

  it('anyone else is sent to a proposal', async () => {
    const t = setup();
    const fromRun = await t.engine.save(RUN, {
      scope: 'team',
      kind: 'hazard',
      title: 't',
      body: 'b',
    });
    const fromAda = await t.engine.save(ADA_LOW, {
      scope: 'project',
      kind: 'fact',
      title: 't',
      body: 'b',
    });
    expect([fromRun.status, fromAda.status]).toEqual(['proposed', 'proposed']);
    expect(t.shared.countEntries()).toBe(0);
  });

  it('a run’s shared save defaults its epic to the task’s parent epic', async () => {
    const t = setup();
    t.host.tasks.set('t-1a2b3c', {
      taskId: 't-1a2b3c',
      title: 'x',
      body: '',
      writes: [],
      epic: 'e-000001',
      risk: 'routine',
      a2a: false,
    });
    const lesson = { scope: 'team', kind: 'hazard', body: 'b' } as const;
    const unnamed = (await t.engine.save(RUN, { ...lesson, title: 'a' })) as {
      proposal: string;
    };
    const named = (await t.engine.save(RUN, {
      ...lesson,
      title: 'b',
      epic: null,
    })) as { proposal: string };
    expect(
      [unnamed, named].map(
        (p) => t.shared.getProposal(p.proposal)?.content?.epic
      )
    ).toEqual(['e-000001', null]);
  });

  it('promotes a personal entry by copying it; the source stays', async () => {
    const t = setup();
    const e = (await t.engine.save(RUN, {
      ...hazard,
      title: 'use bun run test',
    })) as { id: string };
    const copy = (await t.engine.promote(OWNER, e.id, 'team')) as {
      id: string;
    };
    expect(t.shared.getEntry(copy.id)).toMatchObject({
      scope: 'team',
      trust: 'confirmed',
      title: 'use bun run test',
    });
    expect(t.stores.personal('self').getEntry(e.id)?.status).toBe('active');
    const pref = (await t.engine.save(OWNER, {
      ...hazard,
      kind: 'preference',
      title: 'terse comments',
    })) as { id: string };
    expect(await code(t.engine.promote(OWNER, pref.id, 'team'))).toBe(
      'invalid'
    );
  });
});

describe('promoting an overflowed note', () => {
  const DOC = 'doc-01K3Z9R0000000000000000000';
  const overflowed = `kept text\n[truncated by Dispatch: 120 bytes; full text in doc ${DOC} of project aaaaaaaaaaaa]`;

  it("drops the personal doc's marker and ref from the shared copy", async () => {
    const t = setup();
    const e = (await t.engine.save(OWNER, {
      ...hazard,
      scope: 'personal',
      title: 'long note',
      body: overflowed,
      refs: [
        { type: 'doc', id: DOC },
        { type: 'task', id: 't-1a2b3c' },
      ],
    })) as { id: string };
    const copy = (await t.engine.promote(OWNER, e.id, 'team')) as {
      id: string;
    };
    const shared = t.shared.getEntry(copy.id);
    expect(shared?.body).toBe(
      'kept text\n[truncated by Dispatch: 120 bytes; long-form belongs in Docs]'
    );
    expect(shared?.refs).toEqual([{ type: 'task', id: 't-1a2b3c' }]);
    expect(JSON.stringify(shared)).not.toContain(DOC);
  });

  it('strips them from a promotion proposal too', async () => {
    const t = setup();
    const low = { ...OWNER, canDecide: false };
    const e = (await t.engine.save(low, {
      ...hazard,
      scope: 'personal',
      title: 'long note',
      body: overflowed,
      refs: [{ type: 'doc', id: DOC }],
    })) as { id: string };
    const proposed = (await t.engine.promote(low, e.id, 'project')) as {
      proposal: string;
    };
    expect(
      JSON.stringify(t.shared.getProposal(proposed.proposal))
    ).not.toContain(DOC);
  });
});

describe('write edges', () => {
  it('undoing a supersede brings back the entry it replaced', async () => {
    const t = setup();
    const first = (await t.engine.save(OWNER, hazard)) as { id: string };
    const second = (await t.engine.save(RUN, {
      ...hazard,
      title: 'proto shims: symlink ~/.proto/bin/proto',
      supersedes: first.id,
    })) as { id: string };
    t.engine.undo(OWNER, second.id);
    const store = t.stores.personal('self');
    expect(store.getEntry(second.id)).toMatchObject({
      status: 'retired',
      statusReason: 'undone',
    });
    expect(store.getEntry(first.id)).toMatchObject({
      status: 'active',
      statusReason: null,
      supersededBy: null,
      rev: 3,
    });
  });

  it('keeps shared lifecycle ops with decide-tier humans', async () => {
    const t = setup();
    const e = (await t.engine.save(OWNER, {
      scope: 'team',
      kind: 'hazard',
      title: 'flaky server tests',
      body: 'run in chunks',
    })) as { id: string };
    for (const op of [
      () => t.engine.confirm(ADA_LOW, e.id),
      () => t.engine.setPinned(ADA_LOW, e.id, true),
      () => t.engine.undo(ADA_LOW, e.id),
      () => t.engine.hardDelete(ADA_LOW, e.id),
    ])
      expect(await code(op)).toBe('forbidden');
    expect((await t.engine.edit(RUN, e.id, { body: 'x' })).status).toBe(
      'proposed'
    );
    expect((await t.engine.forget(RUN, e.id, 'stale')).status).toBe('proposed');
    expect((await t.engine.forget(ADA, e.id, 'fixed upstream')).status).toBe(
      'retired'
    );
    expect(t.shared.getEntry(e.id)).toMatchObject({
      status: 'retired',
      statusReason: 'forgotten',
    });
    expect(await code(t.engine.edit(ADA, e.id, { body: 'x' }))).toBe('invalid');
    expect(t.engine.undo(ADA, e.id)).toMatchObject({
      status: 'active',
      rev: 3,
    });
  });

  it('refuses projectOnly outside personal scope, a reused origin and a bad baseRev', async () => {
    const t = setup();
    expect(
      await code(
        t.engine.save(OWNER, {
          ...hazard,
          scope: 'team',
          kind: 'hazard',
          projectOnly: true,
        })
      )
    ).toBe('invalid');
    const e = (await t.engine.save(OWNER, {
      ...hazard,
      origin: 'claude:a.md',
    })) as { id: string };
    expect(
      await code(t.engine.save(OWNER, { ...hazard, origin: 'claude:a.md' }))
    ).toBe('conflict');
    expect(await code(t.engine.edit(OWNER, e.id, { baseRev: 2 }))).toBe(
      'invalid'
    );
  });

  it('reads activity for humans only, from an ISO time', async () => {
    const t = setup();
    expect(
      await code(() => t.engine.activity(RUN, '1970-01-01T00:00:00.000Z'))
    ).toBe('forbidden');
    expect(await code(() => t.engine.activity(OWNER, 'yesterday'))).toBe(
      'invalid'
    );
  });
});
