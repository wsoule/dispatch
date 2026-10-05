import { DEFAULT_MEMORY } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import { MemoryEngine } from '../src/engine.js';
import { MemoryError } from '../src/errors.js';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
} from '../src/records.js';
import { FakeMemoryHost, fakeStores, OWNER, RUN } from './fakeHost.js';

// Memory Task 29 (D33): a moved checkout's projectOnly entries re-homed.
const NOW = '2026-09-25T10:00:00.000Z';

function setup() {
  const host = new FakeMemoryHost();
  host.runTasks.set('r-9f2c01', 't-1a2b3c');
  host.operators.set('run:r-9f2c01', { human: 'human:wyat', identity: 'self' });
  host.operators.set('human:wyat', { human: 'human:wyat', identity: 'self' });
  const s = fakeStores();
  const engine = new MemoryEngine({
    stores: s.stores,
    host,
    config: () => DEFAULT_MEMORY,
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

// A personal entry narrowed to the checkout with `projectKey`.
function narrowed(
  t: ReturnType<typeof setup>,
  projectKey: string,
  title = 'from the old checkout'
) {
  return insertFresh(
    t.stores.personal('self'),
    createMemoryIds(),
    Date.now(),
    (id) =>
      newMemoryEntry(
        {
          scope: 'personal',
          kind: 'fact',
          title,
          body: '',
          author: 'human:wyat',
          trust: 'human',
          projectKey,
        },
        id,
        NOW
      ),
    'human:wyat',
    'save'
  );
}

describe('re-homing personal entries', () => {
  it('re-homes the caller’s own entries from another checkout’s key, one revision each', () => {
    const t = setup();
    const mine = t.stores.personal('self');
    const old = narrowed(t, 'bbbbbbbbbbbb');
    narrowed(t, 'cccccccccccc', 'elsewhere');
    narrowed(t, 'aaaaaaaaaaaa', 'already here');
    expect(t.engine.list(OWNER).map((e) => e.id)).not.toContain(old.id);
    expect(t.engine.personalProjectKeys(OWNER)).toEqual({
      current: 'aaaaaaaaaaaa',
      others: [
        { key: 'bbbbbbbbbbbb', count: 1 },
        { key: 'cccccccccccc', count: 1 },
      ],
    });
    expect(t.engine.rehome(OWNER, 'bbbbbbbbbbbb')).toEqual({ moved: 1 });
    expect(mine.getEntry(old.id)).toMatchObject({
      projectKey: 'aaaaaaaaaaaa',
      rev: 2,
    });
    expect(mine.revisions(old.id).at(-1)?.cause).toBe('edit');
    expect(t.engine.list(OWNER).map((e) => e.id)).toContain(old.id);
    expect(t.host.changes.at(-1)).toEqual({ scope: 'personal' });
  });

  it('leaves retired entries out of the counts', () => {
    const t = setup();
    const old = narrowed(t, 'bbbbbbbbbbbb');
    t.stores
      .personal('self')
      .updateEntry(
        { ...old, status: 'retired', rev: 2 },
        'human:wyat',
        'retire'
      );
    expect(t.engine.personalProjectKeys(OWNER).others).toEqual([]);
  });

  it('refuses runs and agents, and a key that is malformed or already current', async () => {
    const t = setup();
    expect(await code(() => t.engine.rehome(RUN, 'bbbbbbbbbbbb'))).toBe(
      'forbidden'
    );
    expect(await code(() => t.engine.personalProjectKeys(RUN))).toBe(
      'forbidden'
    );
    expect(await code(() => t.engine.rehome(OWNER, 'not-a-key'))).toBe(
      'invalid'
    );
    expect(await code(() => t.engine.rehome(OWNER, 'aaaaaaaaaaaa'))).toBe(
      'invalid'
    );
  });
});
