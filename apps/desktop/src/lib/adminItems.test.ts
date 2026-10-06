import { describe, expect, test } from 'bun:test';

import { adminItems } from './adminItems';

describe('adminItems', () => {
  test('nothing waiting is no items', () => {
    expect(adminItems({})).toEqual([]);
  });

  test('each kind of admin item names its count and its Settings page', () => {
    expect(
      adminItems({
        waitingMachines: 2,
        refusedPeers: 1,
        pendingClients: 0,
        skippedFiles: 3,
      })
    ).toEqual([
      { label: '2 machines waiting to join', page: 'team', count: 2 },
      { label: '1 peer credential refused', page: 'a2a', count: 1 },
      { label: '3 Claude files skipped', page: 'memory', count: 3 },
    ]);
  });

  test('singular and plural', () => {
    expect(adminItems({ waitingMachines: 1, pendingClients: 2 })).toEqual([
      { label: '1 machine waiting to join', page: 'team', count: 1 },
      { label: '2 A2A clients pending', page: 'a2a', count: 2 },
    ]);
  });
});
