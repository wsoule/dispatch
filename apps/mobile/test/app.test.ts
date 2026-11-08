import type { RunMeta } from '@dispatch/client';
import { generateKeyPair, pairingUrl, parsePairingUrl } from '@dispatch/remote';
import { describe, expect, test } from 'bun:test';

import { urlFromParams } from '../src/pairing';
import { awaitsReview, byRecency, isLive, stateText } from '../src/runs';

describe('a pairing link opened from the camera', () => {
  const offer = {
    relay: 'wss://remote.dispatch.foo',
    daemonId: 'a'.repeat(32),
    daemonKey: generateKeyPair().publicKey,
    offerId: '0123456789abcdef',
    code: crypto.getRandomValues(new Uint8Array(32)),
    name: "Striker's Mac · dispatch",
  };

  test('rebuilds to the same offer the QR code carried', () => {
    const params = Object.fromEntries(
      new URL(pairingUrl(offer).replace('dispatch-remote:', 'https:'))
        .searchParams
    );
    const url = urlFromParams({ ...params, extra: 'ignored', c: params.c });
    expect(url).not.toBeNull();
    const parsed = parsePairingUrl(url ?? '');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.offer.name).toBe(offer.name);
    expect(parsed.offer.offerId).toBe(offer.offerId);
    expect(parsed.offer.code).toEqual(offer.code);
    expect(url).not.toContain('extra');
  });

  test('is no pairing link without a code', () => {
    expect(urlFromParams({ r: offer.relay })).toBeNull();
    expect(urlFromParams({ c: ['a', 'b'] })).toBeNull();
  });
});

function run(over: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Fix the login bug',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/w',
    createdAt: '2026-11-06T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    ...over,
  };
}

describe('runs', () => {
  test('a finished, unreviewed run waits for review; a reviewed one does not', () => {
    expect(awaitsReview(run({}))).toBe(true);
    expect(
      awaitsReview(
        run({ reviewedAt: '2026-11-06T11:00:00.000Z', reviewAction: 'merge' })
      )
    ).toBe(false);
    expect(awaitsReview(run({ state: 'failed' }))).toBe(false);
  });

  test('says what a run is doing in words', () => {
    expect(
      stateText(
        run({
          state: 'running',
          lastStep: { text: 'Editing src/a.ts', at: '2026-11-06T10:00:00Z' },
        })
      )
    ).toBe('Editing src/a.ts');
    expect(stateText(run({ state: 'awaiting-approval' }))).toBe(
      'Waiting for you'
    );
    expect(
      stateText(
        run({ reviewedAt: '2026-11-06T11:00:00.000Z', reviewAction: 'pr' })
      )
    ).toBe('Sent as a PR');
  });

  test('lists live runs first, then the newest', () => {
    const old = run({ id: 'old', updatedAt: '2026-11-01T00:00:00.000Z' });
    const recent = run({ id: 'recent', updatedAt: '2026-11-06T00:00:00.000Z' });
    const live = run({
      id: 'live',
      state: 'running',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect([old, recent, live].sort(byRecency).map((r) => r.id)).toEqual([
      'live',
      'recent',
      'old',
    ]);
    expect(isLive(live)).toBe(true);
  });
});
