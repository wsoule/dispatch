import { describe, expect, it } from 'bun:test';

import { MemoryError } from '../src/errors.js';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
} from '../src/records.js';
import type { MemoryStore } from '../src/store.js';
import type { MemoryEntry } from '../src/types.js';
import { A2A, ADA, engineWith, RUN } from './fakeHost.js';

const NOW = '2026-09-25T10:00:00.000Z';
const ids = createMemoryIds();

// Takes the MemoryStore interface: `t.stores.personal(...)` returns one.
function put(store: MemoryStore, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return insertFresh(
    store,
    ids,
    Date.parse(NOW),
    (id) => ({
      ...newMemoryEntry(
        {
          scope: 'team',
          kind: 'hazard',
          title: 'pnpm 11 ignores onlyBuiltDependencies',
          body: 'Use allowBuilds.',
          author: 'run:r-1',
          trust: 'agent',
        },
        id,
        NOW
      ),
      ...over,
    }),
    'run:r-1',
    'save'
  );
}

function setup(fts: 'auto' | 'off' = 'auto') {
  const t = engineWith(undefined, fts);
  t.host.runTasks.set('r-9f2c01', 't-1a2b3c');
  t.host.tasks.set('t-1a2b3c', {
    taskId: 't-1a2b3c',
    title: 'Bump pnpm',
    body: 'pnpm allowBuilds migration',
    writes: ['pnpm-workspace.yaml'],
    epic: 'e-000001',
    risk: 'routine',
    a2a: false,
  });
  t.host.operators.set('run:r-9f2c01', {
    human: 'human:wyat',
    identity: 'self',
  });
  t.host.operators.set('human:wyat', { human: 'human:wyat', identity: 'self' });
  t.host.operators.set('human:ada', { human: 'human:ada', identity: 'pid-A' });
  return t;
}

describe('MemoryEngine reads', () => {
  it('lists shared entries plus the viewer’s own personal ones, marking stale', () => {
    const t = setup();
    const team = put(t.shared);
    const stale = put(t.shared, { title: 'stale one', decay: 'stale' });
    const mine = put(t.stores.personal('self'), {
      scope: 'personal',
      kind: 'preference',
      title: 'terse comments',
    });
    const listed = t.engine.list(RUN).map((e) => [e.id, e.state]);
    expect(listed).toContainEqual([team.id, 'active']);
    expect(listed).toContainEqual([stale.id, 'stale']);
    expect(listed).toContainEqual([mine.id, 'active']);
  });

  it('filters by origin source and trust before the limit', () => {
    const t = setup();
    const lesson = put(t.shared, { origin: 'ledger:l-1@2026-09-01' });
    put(t.shared, { origin: 'ledger:l-2@2026-09-01', trust: 'human' });
    put(t.shared, { origin: 'claude:aaaaaaaaaaaa/a.md', pinned: true });
    put(t.shared, { origin: 'ledgers:l-3', pinned: true });
    put(t.shared, { title: 'no origin', pinned: true });
    const listed = (q: Parameters<typeof t.engine.list>[1]) =>
      t.engine.list(RUN, q).map((e) => e.id);
    expect(listed({ origin: 'ledger', trust: 'agent', limit: 1 })).toEqual([
      lesson.id,
    ]);
    expect(listed({ origin: 'ledger' })).toHaveLength(2);
    expect(listed({ trust: 'agent' })).toHaveLength(4);
    expect(listed({ origin: 'amendment' })).toEqual([]);
  });

  // The task page's Memory section lists what reaches the task; an epic's
  // page lists what its tasks' runs narrowed to it.
  it('lists by taskId only the entries that reach that task or epic', () => {
    const t = setup();
    t.host.tasks.set('e-000001', {
      taskId: 'e-000001',
      title: 'pnpm 11',
      body: '',
      writes: [],
      epic: null,
      risk: 'routine',
      a2a: false,
    });
    const wide = put(t.shared, { title: 'everywhere' });
    const mine = put(t.shared, { title: 'this epic', epic: 'e-000001' });
    put(t.shared, { title: 'other epic', epic: 'e-000009' });
    put(t.shared, { title: 'other task', appliesTo: ['t-ffffff'] });
    const titles = (taskId: string) =>
      t.engine
        .list(RUN, { taskId })
        .map((e) => e.title)
        .sort();
    expect(titles('t-1a2b3c')).toEqual([mine.title, wide.title].sort());
    expect(titles('e-000001')).toEqual([mine.title, wide.title].sort());
  });

  // Another identity's personal entry is invisible, and a decide-tier
  // non-owner asking by id gets 403, not the entry.
  it('never returns another identity’s entry', () => {
    const t = setup();
    const wyats = put(t.stores.personal('self'), {
      scope: 'personal',
      kind: 'preference',
      title: 'wyat only',
    });
    expect(t.engine.list(ADA).map((e) => e.id)).not.toContain(wyats.id);
    expect(
      t.engine.search(ADA, { query: 'wyat' }).map((h) => h.id)
    ).not.toContain(wyats.id);
    let caught: unknown;
    try {
      t.engine.read(ADA, wyats.id);
    } catch (err) {
      caught = err;
    }
    expect((caught as MemoryError).code).toBe('forbidden');
    expect(() => t.engine.read({ ...ADA, canDecide: false }, wyats.id)).toThrow(
      /no memory/
    );
  });

  it('refuses A2A agents everywhere and shows A2A runs team entries only', () => {
    const t = setup();
    expect(() => t.engine.list(A2A)).toThrow(MemoryError);
    expect(() => t.engine.search(A2A, { query: 'x' })).toThrow(MemoryError);
    t.host.tasks.set('t-1a2b3c', {
      ...t.host.tasks.get('t-1a2b3c')!,
      a2a: true,
    });
    const local = put(t.shared, { scope: 'project', title: 'local only' });
    const team = put(t.shared);
    const listed = t.engine.list(RUN).map((e) => e.id);
    expect(listed).toContain(team.id);
    expect(listed).not.toContain(local.id);
  });

  it('searches with includeStale on by default and includeRetired off, recording search recalls', () => {
    const t = setup();
    const stale = put(t.shared, { decay: 'stale' });
    const retired = put(t.shared, {
      status: 'retired',
      statusReason: 'forgotten',
    });
    const hits = t.engine
      .search(RUN, { query: 'pnpm allowBuilds' })
      .map((h) => h.id);
    expect(hits).toContain(stale.id);
    expect(hits).not.toContain(retired.id);
    expect(
      t.engine
        .search(RUN, { query: 'pnpm', includeRetired: true })
        .map((h) => h.id)
    ).toContain(retired.id);
    expect(t.shared.getEntry(stale.id)?.decay).toBe('fresh'); // a search recall revives
    expect(t.shared.recallsForRun('r-9f2c01').map((r) => r.via)).toContain(
      'search'
    );
  });

  it('orders hits by bm25, and LIKE-mode hits newest first across stores', () => {
    const fts = setup();
    const both = put(fts.shared, {
      title: 'pnpm allowBuilds pnpm',
      body: 'pnpm allowBuilds',
    });
    const one = put(fts.shared, {
      title: 'pnpm once',
      body: 'a much longer body about other tooling, docker images and nothing else at all',
    });
    expect(fts.engine.search(RUN, { query: 'pnpm' }).map((h) => h.id)).toEqual([
      both.id,
      one.id,
    ]);
    const like = setup('off');
    const older = put(like.shared, {
      title: 'pnpm older',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const newer = put(like.stores.personal('self'), {
      scope: 'personal',
      kind: 'fact',
      title: 'pnpm newer',
      updatedAt: '2026-09-20T00:00:00.000Z',
    });
    expect(like.engine.search(RUN, { query: 'pnpm' }).map((h) => h.id)).toEqual(
      [newer.id, older.id]
    );
  });

  it('answers an empty query with the top entries by rank', () => {
    const t = setup();
    put(t.shared, { kind: 'fact', title: 'a fact' });
    const pinned = put(t.shared, {
      kind: 'fact',
      title: 'pinned fact',
      pinned: true,
    });
    expect(t.engine.search(RUN, { query: '' })[0].id).toBe(pinned.id);
  });

  it('reads by handle, reports ambiguity, and hints at message ids', () => {
    const t = setup();
    const e = put(t.shared);
    expect(t.engine.read(RUN, e.handle).entry.id).toBe(e.id);
    expect(t.shared.recallsForRun('r-9f2c01').map((r) => r.via)).toEqual([
      'read',
    ]);
    expect(() => t.engine.read(RUN, `m-01K5Z6G${'0'.repeat(19)}`)).toThrow(
      'that is a message id'
    );
  });

  it('renders the index for a run and records index recalls, counting only relevant ones as use', () => {
    const t = setup();
    const relevant = put(t.shared);
    const filler = put(t.shared, {
      kind: 'fact',
      title: 'unrelated filler about docker',
      body: 'containers only',
    });
    const out = t.engine.index({
      principal: RUN,
      taskId: 't-1a2b3c',
      runId: 'r-9f2c01',
      variant: 'tools',
    });
    expect(out.text).toContain(relevant.handle);
    expect(t.shared.getEntry(relevant.id)?.lastRecalledAt).toBe(NOW);
    expect(t.shared.getEntry(filler.id)?.lastRecalledAt).toBeNull(); // filled the index, not evidence of need
    expect(
      t.shared
        .recallsForRun('r-9f2c01')
        .map((r) => r.memoryId)
        .sort()
    ).toEqual([relevant.id, filler.id].sort());
  });

  it('marks unavailable personal memory in the index instead of failing', () => {
    const t = setup();
    put(t.shared);
    t.down.add('self');
    expect(
      t.engine.index({
        principal: RUN,
        taskId: 't-1a2b3c',
        runId: 'r-9f2c01',
        variant: 'tools',
      }).text
    ).toContain('(personal memory unavailable)');
  });

  it('keeps the rendered index when a recall write fails, reporting it to onRecallError', () => {
    const t = setup();
    const e = put(t.shared);
    t.shared.recordRecall = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    const req = {
      principal: RUN,
      taskId: 't-1a2b3c',
      runId: 'r-9f2c01',
      variant: 'tools',
    } as const;
    expect(() => t.engine.index(req)).toThrow('SQLITE_BUSY');
    const errors: unknown[] = [];
    const out = t.engine.index({
      ...req,
      onRecallError: (err) => errors.push(err),
    });
    expect(out.text).toContain(e.handle);
    expect(errors.map((err) => String(err))).toEqual([
      'Error: SQLITE_BUSY: database is locked',
    ]);
  });
});
