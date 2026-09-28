import type { EpicProgress, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { liveCeilingsOf, spendToday } from './liveSpend';

function run(id: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: `r-${id}`,
    taskId: id,
    state: 'finished',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  } as RunMeta;
}

// A live fan-out with its settled spend and, when given, a spend ceiling.
function progress(
  epicId: string,
  state: 'active' | 'paused',
  maxSpendUsd: number | null,
  settledUsd: number
): EpicProgress {
  return {
    epicId,
    session: { epicId, state, maxSpendUsd },
    spend: { settledUsd },
  } as EpicProgress;
}

describe('spendToday', () => {
  // Noon local time, whatever zone the suite runs in.
  const now = new Date(2026, 8, 25, 12, 0, 0).getTime();
  const iso = (hoursAgo: number) =>
    new Date(now - hoursAgo * 3_600_000).toISOString();

  test('sums settled cost on runs that finished since midnight', () => {
    expect(
      spendToday(
        [
          run('a', { costUsd: 1.5, updatedAt: iso(1) }),
          run('b', { costUsd: 2.25, updatedAt: iso(11) }),
          // Yesterday evening.
          run('c', { costUsd: 9, updatedAt: iso(13) }),
          // Still running: no cost stamped yet.
          run('d', { state: 'running', updatedAt: iso(0) }),
        ],
        now
      )
    ).toBe(3.75);
  });

  test('is null until something cost anything', () => {
    expect(spendToday([run('a', { updatedAt: iso(1) })], now)).toBeNull();
    expect(spendToday([], now)).toBeNull();
  });
});

describe('liveCeilingsOf', () => {
  test('adds the live fan-outs’ spend and the ceilings they set', () => {
    expect(
      liveCeilingsOf([
        progress('m-1', 'active', 40, 12),
        progress('m-2', 'paused', null, 3),
        progress('m-3', 'active', 20, 0.5),
      ])
    ).toEqual({ live: 3, settledUsd: 15.5, ceilingUsd: 60 });
  });

  test('no ceiling set reads as null; no fan-out reads as nothing', () => {
    expect(liveCeilingsOf([progress('m-1', 'active', null, 2)])).toEqual({
      live: 1,
      settledUsd: 2,
      ceilingUsd: null,
    });
    expect(liveCeilingsOf([])).toBeNull();
  });
});
