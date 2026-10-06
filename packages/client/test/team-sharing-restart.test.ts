import { describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/api';

// Team start and join on a daemon with board sync off: it answers
// `restarting`, comes back with sync on, and the client asks once more.
describe('team actions across the restart that turns sync on', () => {
  it('waits for sync to be on, then sends the same join again', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    let joins = 0;
    let probes = 0;
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      seen.push(`${init?.method ?? 'GET'} ${path}`);
      const json = (body: unknown, status = 200) =>
        Promise.resolve(Response.json(body, { status }));
      if (path === '/api/team/join') {
        joins += 1;
        return joins === 1
          ? json({ restarting: true, code: 'restarting' }, 202)
          : json({ team: { id: 't', name: 'acme' }, check: '123 456' });
      }
      if (path === '/api/board-sync') {
        probes += 1;
        // Down once while it restarts, then off, then on.
        if (probes === 1) return Promise.reject(new TypeError('refused'));
        return json({ enabled: probes > 2 });
      }
      return json({}, 404);
    }) as typeof fetch;
    try {
      const joined = await createApiClient(
        'http://example.test',
        'app-token'
      ).joinTeam('dispatch-team:LINK');
      expect(joined.team.name).toBe('acme');
      expect(seen).toEqual([
        'POST /api/team/join',
        'GET /api/board-sync',
        'GET /api/board-sync',
        'GET /api/board-sync',
        'POST /api/team/join',
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps waiting while a move to the team's repo is still restarting", async () => {
    const original = globalThis.fetch;
    let joins = 0;
    globalThis.fetch = ((url: string | URL) => {
      const path = new URL(String(url)).pathname;
      const json = (body: unknown, status = 200) =>
        Promise.resolve(Response.json(body, { status }));
      if (path === '/api/team/join') {
        joins += 1;
        // Sync is already on, so the probe passes before the restart lands.
        return joins < 3
          ? json({ restarting: true, code: 'restarting' }, 202)
          : json({ team: { id: 't', name: 'acme' } });
      }
      if (path === '/api/board-sync') return json({ enabled: true });
      return json({}, 404);
    }) as typeof fetch;
    try {
      const joined = await createApiClient(
        'http://example.test',
        'app-token'
      ).joinTeam('dispatch-team:LINK');
      expect([joined.team.name, joins]).toEqual(['acme', 3]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
