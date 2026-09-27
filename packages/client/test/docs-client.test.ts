import { describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/api';

const BASE = 'http://example.test';

// Answers every fetch with one status and JSON body, recording each call.
function stub(
  status: number,
  body: unknown
): { calls: { url: string; init?: RequestInit }[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// Each binding must hit the route the server's docs/routes.ts registers, with
// the query parameters it parses.
describe('docs bindings', () => {
  it('encodes a personal handle and passes read options', async () => {
    const s = stub(200, {});
    try {
      await createApiClient(BASE, 't').getDoc('~notes', {
        section: 'API',
        page: true,
      });
      expect(s.calls[0].url).toBe(`${BASE}/api/docs/~notes?section=API&page=1`);
    } finally {
      s.restore();
    }
  });

  it('returns a 409 conflict as a value instead of throwing', async () => {
    const conflict = {
      error: 'x',
      code: 'conflict',
      reason: 'merge-conflict',
      head: { id: 'rev-1', n: 2, hash: 'h', body: 'b', author: 'run:r-1' },
      base: { id: 'rev-0', n: 1 },
      hunks: [],
      marked: 'm',
    };
    const s = stub(409, conflict);
    try {
      const out = await createApiClient(BASE, 't').saveDocBody('spec', {
        baseRev: 1,
        body: 'x',
      });
      expect(out).toEqual({ ok: false, conflict: conflict as never });
      expect(s.calls[0].init?.method).toBe('PUT');
    } finally {
      s.restore();
    }
  });

  it('still throws other failures', async () => {
    const s = stub(403, { error: 'no', code: 'forbidden' });
    try {
      await expect(
        createApiClient(BASE, 't').saveDocBody('spec', {
          baseRev: 1,
          body: 'x',
        })
      ).rejects.toThrow('no');
    } finally {
      s.restore();
    }
  });

  it('builds list, search, links and unlink paths', async () => {
    const s = stub(200, { docs: [], total: 0, hits: [], links: [] });
    try {
      const c = createApiClient(BASE, 't');
      await c.listDocs({ taskId: 't-1', includeArchived: true, limit: 5 });
      await c.searchDocs('two words', { limit: 3 });
      await c.docsLinking('task:t-1');
      await c.unlinkDoc('spec', 'task:t-1');
      expect(s.calls.map((c2) => c2.url)).toEqual([
        `${BASE}/api/docs?taskId=t-1&includeArchived=1&limit=5`,
        `${BASE}/api/docs/search?q=two+words&limit=3`,
        `${BASE}/api/docs/links?target=task%3At-1`,
        `${BASE}/api/docs/spec/links/task/t-1`,
      ]);
    } finally {
      s.restore();
    }
  });
});
