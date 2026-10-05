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

  it('posts the Claude-notes import with only the options given', async () => {
    const stub = stubFetch({ report: {} });
    try {
      const client = createApiClient(BASE);
      await client.importClaude();
      await client.importClaude({ from: '/home/wyat/notes', dryRun: true });
      await client.importClaude({ none: true });
      expect(stub.calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([
        [`${BASE}/api/memory/import/claude`, 'POST'],
        [
          `${BASE}/api/memory/import/claude?${new URLSearchParams({ from: '/home/wyat/notes', dryRun: '1' }).toString()}`,
          'POST',
        ],
        [`${BASE}/api/memory/import/claude?none=1`, 'POST'],
      ]);
    } finally {
      stub.restore();
    }
  });

  it('asks the ledger for its receipts alone with class=audit', async () => {
    const stub = stubFetch([]);
    try {
      const client = createApiClient(BASE);
      await client.fetchLedger({ class: 'audit' });
      await client.fetchLedger({ epicId: null, class: 'audit' });
      await client.fetchLedger();
      expect(stub.calls.map((c) => c.url)).toEqual([
        `${BASE}/api/ledger?class=audit`,
        `${BASE}/api/ledger?epicId=&class=audit`,
        `${BASE}/api/ledger`,
      ]);
    } finally {
      stub.restore();
    }
  });
});

// One request per binding: method, path (refs percent-encoded) and body.
describe('memory write and Settings bindings', () => {
  type Call = [url: string, method: string, body: unknown];
  const REF = '#7QX2K9PA';
  const ENC = '%237QX2K9PA';

  async function calls(
    use: (client: ReturnType<typeof createApiClient>) => Promise<unknown>
  ): Promise<Call[]> {
    const stub = stubFetch({});
    try {
      await use(createApiClient(BASE));
      return stub.calls.map((c) => [
        c.url,
        c.init?.method ?? 'GET',
        typeof c.init?.body === 'string' ? JSON.parse(c.init.body) : undefined,
      ]);
    } finally {
      stub.restore();
    }
  }

  it('saves with the Idempotency-Key header when one is given', async () => {
    const stub = stubFetch({ status: 'active', id: 'mem-1', handle: REF });
    try {
      const client = createApiClient(BASE);
      const input = {
        scope: 'personal' as const,
        kind: 'fact' as const,
        title: 'proto shims',
        body: '',
        projectOnly: true,
      };
      await client.saveMemory(input, { idempotencyKey: 'k-1' });
      await client.saveMemory(input);
      expect(stub.calls[0].url).toBe(`${BASE}/api/memory`);
      expect(stub.calls[0].init?.method).toBe('POST');
      expect(JSON.parse(stub.calls[0].init?.body as string)).toEqual(input);
      expect(
        new Headers(stub.calls[0].init?.headers).get('idempotency-key')
      ).toBe('k-1');
      expect(
        new Headers(stub.calls[1].init?.headers).has('idempotency-key')
      ).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('retires with a reason', async () => {
    expect(await calls((c) => c.retireMemory(REF, 'wrong'))).toEqual([
      [`${BASE}/api/memory/${ENC}/retire`, 'POST', { reason: 'wrong' }],
    ]);
  });

  it('undoes, confirms, pins and unpins by ref', async () => {
    expect(
      await calls(async (c) => {
        await c.undoMemory(REF);
        await c.confirmMemory(REF);
        await c.pinMemory(REF, true);
        await c.pinMemory(REF, false);
      })
    ).toEqual([
      [`${BASE}/api/memory/${ENC}/undo`, 'POST', undefined],
      [`${BASE}/api/memory/${ENC}/confirm`, 'POST', undefined],
      [`${BASE}/api/memory/${ENC}/pin`, 'POST', undefined],
      [`${BASE}/api/memory/${ENC}/unpin`, 'POST', undefined],
    ]);
  });

  it('promotes to a shared scope', async () => {
    expect(await calls((c) => c.promoteMemory(REF, 'team'))).toEqual([
      [`${BASE}/api/memory/${ENC}/promote`, 'POST', { scope: 'team' }],
    ]);
  });

  it('deletes by ref', async () => {
    expect(await calls((c) => c.deleteMemory(REF))).toEqual([
      [`${BASE}/api/memory/${ENC}`, 'DELETE', undefined],
    ]);
  });

  it('lists proposals, with a state when given, and reads one', async () => {
    expect(
      await calls(async (c) => {
        await c.listMemoryProposals();
        await c.listMemoryProposals('open');
        await c.getMemoryProposal('mp-01K');
      })
    ).toEqual([
      [`${BASE}/api/memory/proposals`, 'GET', undefined],
      [`${BASE}/api/memory/proposals?state=open`, 'GET', undefined],
      [`${BASE}/api/memory/proposals/mp-01K`, 'GET', undefined],
    ]);
  });

  it('reads activity since a time, and the last day by default', async () => {
    expect(
      await calls(async (c) => {
        await c.memoryActivity();
        await c.memoryActivity('2026-09-25T10:00:00.000Z');
      })
    ).toEqual([
      [`${BASE}/api/memory/activity`, 'GET', undefined],
      [
        `${BASE}/api/memory/activity?since=2026-09-25T10%3A00%3A00.000Z`,
        'GET',
        undefined,
      ],
    ]);
  });

  it('reads the caller’s identity', async () => {
    expect(await calls((c) => c.memoryIdentity())).toEqual([
      [`${BASE}/api/memory/identity`, 'GET', undefined],
    ]);
  });

  it('starts a link, a fresh identity, and completes a code', async () => {
    expect(
      await calls(async (c) => {
        await c.startMemoryLink();
        await c.startMemoryLink({ fresh: true });
        await c.completeMemoryLink('7QX2-K9PA');
      })
    ).toEqual([
      [`${BASE}/api/memory/link`, 'POST', {}],
      [`${BASE}/api/memory/link`, 'POST', { fresh: true }],
      [`${BASE}/api/memory/link/7QX2-K9PA`, 'POST', undefined],
    ]);
  });

  it('lists skipped files and accepts one', async () => {
    expect(
      await calls(async (c) => {
        await c.listIngestProblems();
        await c.acceptIngestProblem('ip-1');
      })
    ).toEqual([
      [`${BASE}/api/memory/ingest-problems`, 'GET', undefined],
      [`${BASE}/api/memory/ingest-problems/ip-1/accept`, 'POST', undefined],
    ]);
  });

  it('lists by origin and trust', async () => {
    expect(
      await calls((c) =>
        c.listMemory({ origin: 'ledger', trust: 'agent', limit: 200 })
      )
    ).toEqual([
      [
        `${BASE}/api/memory?origin=ledger&trust=agent&limit=200`,
        'GET',
        undefined,
      ],
    ]);
  });
});
