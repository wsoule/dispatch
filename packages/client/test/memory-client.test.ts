import { describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/api';

// Captures the (url, init) a stubbed `fetch` was called with. Mirrors
// messaging-client.test.ts's helper — kept local since neither is exported.
function stubFetch(responseBody: unknown = {}): {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((
    url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const BASE = 'http://example.test';

// Each binding must hit the route the server's memory/routes.ts registers,
// with the query parameters it parses.
describe('memory bindings', () => {
  it('percent-encodes a #handle', async () => {
    const stub = stubFetch({ entry: {}, revisions: [], recallCount: 0 });
    try {
      await createApiClient(BASE).getMemory('#7QX2K9PA');
      expect(stub.calls[0].url).toBe(`${BASE}/api/memory/%237QX2K9PA`);
    } finally {
      stub.restore();
    }
  });

  it('sends search flags as 1/0 and omits absent ones', async () => {
    const stub = stubFetch({ hits: [], search: 'fts5' });
    try {
      await createApiClient(BASE).searchMemory({
        query: 'pnpm',
        includeStale: false,
        limit: 5,
      });
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/memory/search?q=pnpm&includeStale=0&limit=5`
      );
    } finally {
      stub.restore();
    }
  });

  it('lists with only the filters given, and with none as a bare path', async () => {
    const stub = stubFetch({ entries: [] });
    try {
      const client = createApiClient(BASE);
      await client.listMemory();
      await client.listMemory({ kind: 'hazard', state: 'all', taskId: 't-1' });
      expect(stub.calls.map((c) => c.url)).toEqual([
        `${BASE}/api/memory`,
        `${BASE}/api/memory?kind=hazard&state=all&taskId=t-1`,
      ]);
    } finally {
      stub.restore();
    }
  });

  it('asks for a run’s index by runId and posts the dry-run import', async () => {
    const stub = stubFetch({});
    try {
      const client = createApiClient(BASE);
      await client.memoryIndex({ runId: 'r-9f2c01' });
      await client.importLedger({ dryRun: true });
      expect(stub.calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([
        [`${BASE}/api/memory/index?runId=r-9f2c01`, 'GET'],
        [`${BASE}/api/memory/import/ledger?dryRun=1`, 'POST'],
      ]);
    } finally {
      stub.restore();
    }
  });

  it('reads recalls and health, and imports for real without a query', async () => {
    const stub = stubFetch({});
    try {
      const client = createApiClient(BASE);
      await client.memoryRecalls('r-9f2c01');
      await client.memoryHealth();
      await client.importLedger();
      expect(stub.calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([
        [`${BASE}/api/memory/recalls?runId=r-9f2c01`, 'GET'],
        [`${BASE}/api/memory/health`, 'GET'],
        [`${BASE}/api/memory/import/ledger`, 'POST'],
      ]);
    } finally {
      stub.restore();
    }
  });
});
