import type { SyncStatus } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { syncSummary } from './SyncChip';

// A file-backend project (no receipt log) with nothing pending, on which each case
// overrides the field it is about.
function boardStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    pushed: 0,
    pulled: 0,
    state: 'idle',
    detail: null,
    pendingOutgoing: 0,
    pendingIncoming: 0,
    lastSyncedAt: null,
    mergeDriverWarning: null,
    receipts: {
      state: 'disabled',
      detail: null,
      commit: null,
      changed: 0,
      removed: 0,
      problems: 0,
      lastExportedAt: null,
    },
    ...overrides,
  };
}

describe('syncSummary — board syncer', () => {
  test('idle before the first sync', () => {
    const summary = syncSummary(boardStatus());
    expect(summary.tone).toBe('review');
    expect(summary.message).toBe('Not synced yet');
    expect(summary.detail).toEqual([]);
    expect(summary.canDisableAutoCommit).toBe(true);
  });

  test('idle after a sync reads the relative time', () => {
    const summary = syncSummary(
      boardStatus({ lastSyncedAt: new Date().toISOString() })
    );
    expect(summary.message).toMatch(/^Synced /);
  });

  test('local-only is amber and carries the push failure', () => {
    const summary = syncSummary(
      boardStatus({ state: 'local-only', detail: 'remote rejected' })
    );
    expect(summary.tone).toBe('waiting');
    expect(summary.message).toBe(
      'Committed locally, but the push failed: remote rejected'
    );
    expect(summary.canDisableAutoCommit).toBe(true);
  });

  test('blocked is red', () => {
    expect(syncSummary(boardStatus({ state: 'blocked' }))).toMatchObject({
      tone: 'failed',
      message: 'A sync conflict needs resolving',
      canDisableAutoCommit: true,
    });
    expect(
      syncSummary(boardStatus({ state: 'blocked', detail: 'tasks/t-1.md' }))
        .message
    ).toBe('Sync conflict: tasks/t-1.md');
  });

  test('disabled and off have nothing to switch off', () => {
    const disabled = syncSummary(
      boardStatus({ state: 'disabled', detail: 'No trunk resolvable' })
    );
    expect(disabled.tone).toBe('blocked');
    expect(disabled.message).toBe('No trunk resolvable');
    expect(disabled.canDisableAutoCommit).toBe(false);
    expect(syncSummary(boardStatus({ state: 'disabled' })).message).toBe(
      'Task files not committed'
    );

    const off = syncSummary(boardStatus({ state: 'off' }));
    expect(off.tone).toBe('ready');
    expect(off.message).toBe(
      'Task files not committed · Settings → Board sync'
    );
    expect(off.canDisableAutoCommit).toBe(false);
  });

  test('pending counts and the merge-driver warning are tooltip lines', () => {
    const summary = syncSummary(
      boardStatus({
        pendingOutgoing: 2,
        pendingIncoming: 1,
        mergeDriverWarning: 'dispatch merge-task not on PATH',
      })
    );
    expect(summary.detail).toEqual([
      '2 to push',
      '1 incoming',
      'Task merge driver not set up: dispatch merge-task not on PATH',
    ]);
    // The warning never changes the one-line message.
    expect(summary.message).toBe('Not synced yet');
  });
});

describe('syncSummary — receipts exporter', () => {
  test('a database-backed project reports the exporter, not the disabled board syncer', () => {
    const summary = syncSummary(
      boardStatus({
        state: 'disabled',
        pendingOutgoing: 3,
        mergeDriverWarning: 'ignored on receipts projects',
        receipts: {
          state: 'clean',
          detail: null,
          commit: 'abc123',
          changed: 0,
          removed: 0,
          problems: 0,
          lastExportedAt: null,
        },
      })
    );
    expect(summary.tone).toBe('ready');
    expect(summary.message).toBe('Receipts up to date');
    expect(summary.detail).toEqual([]);
    expect(summary.canDisableAutoCommit).toBe(false);
  });

  test('each receipts state maps to its own tone and line', () => {
    const receipts = boardStatus().receipts;
    const of = (partial: Partial<SyncStatus['receipts']>) =>
      syncSummary(boardStatus({ receipts: { ...receipts, ...partial } }));

    expect(of({ state: 'committed' })).toMatchObject({
      tone: 'ready',
      message: 'Receipts committed',
    });
    expect(
      of({ state: 'committed', lastExportedAt: new Date().toISOString() })
        .message
    ).toMatch(/^Receipts committed /);
    expect(of({ state: 'failed', detail: 'disk full' })).toMatchObject({
      tone: 'failed',
      message: 'Receipt export failed: disk full',
    });
    expect(of({ state: 'failed' }).message).toBe('Receipt export failed');
    expect(of({ state: 'idle' })).toMatchObject({
      tone: 'review',
      message: 'No receipts exported yet',
    });
  });
});
