import { openDispatchDb, SqliteTaskStore } from '@dispatch/core';
import { hlcWallMs, MAX_CLOCK_LEAD_MS } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BoardOp } from '../../src/team/boardSync/engine.js';
import { SyncLedger } from '../../src/team/boardSync/ledger.js';
import { SyncedTaskStore } from '../../src/team/boardSync/syncedStore.js';

// FW-R21 on v1 board sync: a change stamped far ahead of this machine's clock
// waits, unapplied and unobserved, until the clock comes within the bound.

const T = Date.parse('2026-10-01T10:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a v1 change from far ahead', () => {
  it('is held until the clock catches up, and never moves the clock', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'v1-clock-')));
    dirs.push(dir);
    let now = T;
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada', () => now);
    const store = new SyncedTaskStore(
      new SqliteTaskStore(dir, openDispatchDb(':memory:')),
      ledger
    );
    const at = T + MAX_CLOCK_LEAD_MS + 60_000;
    const op: BoardOp = {
      v: 1,
      replica: 'bob-0000000b',
      seq: 1,
      hlc: `${String(at)}.0000.bob-0000000b`,
      task: 't-00000a01',
      kind: 'put',
      origin: new Date(at).toISOString(),
      fields: { title: 'from the future' },
    };
    expect(store.applyRemote(op)).toMatchObject({ changed: false, held: true });
    expect(store.get('t-00000a01')).toBeNull();
    expect(hlcWallMs(ledger.clock.tick())).toBe(T);
    now = at;
    expect(store.applyRemote(op)).toMatchObject({ changed: true });
    expect(store.get('t-00000a01')?.meta.title).toBe('from the future');
    ledger.close();
  });
});
