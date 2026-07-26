import { describe, expect, test } from 'bun:test';

import { resetTrackingForRoot } from './useTransitionNotifications';
import type { TransitionTrackingState } from './useTransitionNotifications';

// A tracking state with a run and a queue entry already recorded, as if this hook had
// been diffing against `root` for a while — used to assert a root change wipes both
// maps rather than carrying either into the new project.
function populatedTracking(root: string | null): TransitionTrackingState {
  return {
    root,
    runStates: new Map([['run-1', 'finished']]),
    queueStates: new Map([['run-1', 'merged']]),
  };
}

describe('resetTrackingForRoot', () => {
  test('same root returns the identical state (no reset)', () => {
    const state = populatedTracking('/repo/a');
    const next = resetTrackingForRoot(state, '/repo/a');
    expect(next).toBe(state);
    expect(next.runStates.size).toBe(1);
    expect(next.queueStates.size).toBe(1);
  });

  test('switching to a different project root clears both tracking maps', () => {
    const state = populatedTracking('/repo/a');
    const next = resetTrackingForRoot(state, '/repo/b');
    expect(next.root).toBe('/repo/b');
    expect(next.runStates.size).toBe(0);
    expect(next.queueStates.size).toBe(0);
  });

  test('switching from no project to a project clears the maps (covers app-launch-into-project)', () => {
    const state = populatedTracking(null);
    const next = resetTrackingForRoot(state, '/repo/a');
    expect(next.root).toBe('/repo/a');
    expect(next.runStates.size).toBe(0);
    expect(next.queueStates.size).toBe(0);
  });

  test('switching from a project to no project clears the maps', () => {
    const state = populatedTracking('/repo/a');
    const next = resetTrackingForRoot(state, null);
    expect(next.root).toBeNull();
    expect(next.runStates.size).toBe(0);
    expect(next.queueStates.size).toBe(0);
  });

  test('a reset state re-arms the first-load guard: a run already terminal under the old root does not replay as a fresh transition under the new root', () => {
    // Simulate switching back to a project this window watched before: under the old
    // root, run-1 was seen transitioning into 'finished' (tracked in the map).
    // Reopening it should not treat run-1's still-'finished' state as a transition —
    // that requires the reset map to have no entry for run-1 at all, which is exactly
    // what diffRunNotifications's "no previous entry never notifies" rule needs.
    const state = populatedTracking('/repo/old');
    const next = resetTrackingForRoot(state, '/repo/new');
    expect(next.runStates.has('run-1')).toBe(false);
    expect(next.queueStates.has('run-1')).toBe(false);
  });

  test('an unrelated re-render with the same root twice in a row keeps returning the same reference', () => {
    const state = populatedTracking('/repo/a');
    const first = resetTrackingForRoot(state, '/repo/a');
    const second = resetTrackingForRoot(first, '/repo/a');
    expect(second).toBe(state);
  });
});
