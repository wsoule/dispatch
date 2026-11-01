import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  createLinearApiClient,
  LinearRouteMissingError,
} from '../src/apiClient.js';
import { CliError } from '../src/context.js';

let server: ReturnType<typeof Bun.serve>;
let seen: {
  method: string;
  path: string;
  auth: string | null;
  body: string;
}[] = [];

beforeEach(() => {
  seen = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get('authorization'),
        body: await req.text(),
      });
      if (url.pathname === '/api/linear/capacity')
        return Response.json(
          { error: 'no Linear API key configured' },
          { status: 409 }
        );
      if (url.pathname === '/api/linear/coverage')
        return Response.json(
          { error: `not found: ${url.pathname}` },
          { status: 404 }
        );
      if (url.pathname === '/api/linear/export' && req.method === 'POST')
        return Response.json(
          { started: true, candidates: 2, startedAt: 's' },
          { status: 202 }
        );
      return Response.json({ ok: true });
    },
  });
});
afterEach(() => void server.stop(true));

function api() {
  return createLinearApiClient(`http://127.0.0.1:${server.port}`, 'tok');
}

describe('createLinearApiClient', () => {
  it('sends each call to its route with the Bearer token', async () => {
    const client = api();
    await client.linearStatus();
    await client.linearSync();
    await client.linearSync(['t-a', 't-b']);
    await client.linearImport();
    await client.linearExportPreview();
    expect(await client.linearExport('all-archive-finished')).toEqual({
      started: true,
      candidates: 2,
      startedAt: 's',
    });
    await client.linearRetry();
    await client.linearRetry(['t-a']);
    await client.linearForget(['t-a']);
    await client.linearArchiveClosed({ includeCanceled: true });
    await client.linearLinks();
    expect(
      seen.map((s) => `${s.method} ${s.path} ${s.body}`.trimEnd())
    ).toEqual([
      'GET /api/linear/status',
      'POST /api/linear/sync {}',
      'POST /api/linear/sync {"taskIds":["t-a","t-b"]}',
      'POST /api/linear/import',
      'GET /api/linear/export',
      'POST /api/linear/export {"scope":"all-archive-finished"}',
      'POST /api/linear/retry {}',
      'POST /api/linear/retry {"taskIds":["t-a"]}',
      'POST /api/linear/forget {"taskIds":["t-a"]}',
      'POST /api/linear/archive-closed {"includeCanceled":true}',
      'GET /api/linear/links',
    ]);
    expect(new Set(seen.map((s) => s.auth))).toEqual(new Set(['Bearer tok']));
  });

  it('asks for a fresh capacity count only with refresh', async () => {
    const client = api();
    await client.linearCapacity().catch(() => undefined);
    await client.linearCapacity(true).catch(() => undefined);
    expect(seen.map((s) => s.path)).toEqual([
      '/api/linear/capacity',
      '/api/linear/capacity?refresh=1',
    ]);
  });

  it("surfaces the daemon's own words", async () => {
    const err = await api()
      .linearCapacity()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).not.toBeInstanceOf(LinearRouteMissingError);
    expect((err as Error).message).toBe('no Linear API key configured');
  });

  it('names the command an older daemon lacks', async () => {
    const err = await api()
      .linearCoverage()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearRouteMissingError);
    expect((err as Error).message).toBe(
      'this dispatchd predates dispatch linear coverage; update Dispatch and try again'
    );
  });
});
