// Query keys for the surfaces a `config.changed` event invalidates, kept here so the
// event handler and the queries themselves cannot drift apart.

/** React Query key for `GET /api/config`. */
export function dispatchConfigKey(port: number): [string, number] {
  return ['dispatch-config', port];
}

/** React Query key for `GET /api/linear/status`. */
export function linearStatusKey(port: number): [string, number] {
  return ['dispatch-linear-status', port];
}

/** React Query key for `GET /api/sync`. */
export function syncStatusKey(port: number): [string, number] {
  return ['dispatch-sync-status', port];
}

/**
 * What a `config.changed` event has to refetch. The daemon emits it both for a Settings
 * PATCH of `.dispatch/config.yml` and for Linear connect/disconnect, which writes a
 * credential the config file never sees and only `/api/linear/status` reports — and it
 * names neither, so all three are refetched. Sync status is included because
 * `autoCommit` — the setting the sync chip renders — lives in that same config file, so
 * flipping it in Settings must update the chip without waiting for the next `board.sync`.
 */
export function configChangedQueryKeys(port: number): [string, number][] {
  return [dispatchConfigKey(port), linearStatusKey(port), syncStatusKey(port)];
}
