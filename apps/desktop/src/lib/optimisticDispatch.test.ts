import { describe, expect, test } from 'bun:test';

import {
  NO_PENDING,
  PENDING_TIMEOUT_MS,
  pendingStarts,
  reconcileDispatches,
  rollbackDispatch,
  settleDispatch,
  startDispatch,
} from './optimisticDispatch';

const always = () => true;

describe('optimistic dispatch', () => {
  test('start holds the task in flight; a second start keeps the first', () => {
    const one = startDispatch(NO_PENDING, 't-1', 100);
    expect(pendingStarts(one)).toEqual(new Map([['t-1', 100]]));
    expect(startDispatch(one, 't-1', 999)).toBe(one);
  });

  test('a failed request rolls the task back out', () => {
    const one = startDispatch(NO_PENDING, 't-1', 100);
    expect(rollbackDispatch(one, 't-1').size).toBe(0);
    expect(rollbackDispatch(one, 't-2')).toBe(one);
  });

  test('a sending dispatch survives reconcile until its request answers', () => {
    const one = startDispatch(NO_PENDING, 't-1', 100);
    expect(reconcileDispatches(one, new Set(['t-1']), always, 200)).toBe(one);
  });

  test('a settled dispatch leaves once its run is live', () => {
    const sent = settleDispatch(startDispatch(NO_PENDING, 't-1', 100), 't-1');
    expect(reconcileDispatches(sent, new Set(), always, 200)).toBe(sent);
    expect(reconcileDispatches(sent, new Set(['t-1']), always, 200).size).toBe(
      0
    );
  });

  test('…or once the task stopped waiting to start', () => {
    const sent = settleDispatch(startDispatch(NO_PENDING, 't-1', 100), 't-1');
    expect(reconcileDispatches(sent, new Set(), () => false, 200).size).toBe(0);
  });

  test('…or when its run never shows up', () => {
    const sent = settleDispatch(startDispatch(NO_PENDING, 't-1', 100), 't-1');
    expect(
      reconcileDispatches(sent, new Set(), always, 100 + PENDING_TIMEOUT_MS + 1)
        .size
    ).toBe(0);
  });
});
