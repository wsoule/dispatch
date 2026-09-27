import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CliError } from '../src/context.js';
import { createDocsApi } from '../src/docsApi.js';

let server: ReturnType<typeof Bun.serve>;
let seen: {
  method: string;
  path: string;
  auth: string | null;
  type: string | null;
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
        type: req.headers.get('content-type'),
        body: await req.text(),
      });
      if (url.pathname === '/api/docs/archived/body') {
        return Response.json(
          {
            error: 'archived; restore it first',
            code: 'conflict',
            field: 'doc',
          },
          { status: 409 }
        );
      }
      if (url.pathname.endsWith('/body')) {
        return Response.json(
          {
            code: 'conflict',
            reason: 'base-changed',
            head: {
              id: 'rev-2',
              n: 2,
              hash: 'h2',
              body: 'new',
              author: 'human:x',
            },
            base: null,
            hunks: [],
            marked: 'new',
            error: 'e',
          },
          { status: 409 }
        );
      }
      if (url.pathname === '/api/docs/missing') {
        return Response.json(
          { error: 'doc missing not found', code: 'not-found', field: 'doc' },
          { status: 404 }
        );
      }
      return Response.json({ ok: true });
    },
  });
});
afterEach(() => void server.stop(true));

describe('createDocsApi', () => {
  it('sends the token and turns 409 into a conflict value', async () => {
    const api = createDocsApi(`http://127.0.0.1:${server.port}`, 'app-token');
    const out = await api.saveBody('spec', {
      baseRev: 'rev-1',
      baseHash: 'h1',
      body: 'mine',
    });
    expect(out).toMatchObject({
      ok: false,
      conflict: { reason: 'base-changed', head: { id: 'rev-2' } },
    });
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      path: '/api/docs/spec/body',
      auth: 'Bearer app-token',
    });
  });

  it('throws a 409 that carries no merge conflict, such as an archived doc', async () => {
    const api = createDocsApi(`http://127.0.0.1:${server.port}`, 'app-token');
    const err: unknown = await api
      .saveBody('archived', { baseRev: 'rev-1', body: 'mine' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({
      message: 'archived; restore it first (field: doc)',
    });
  });

  it('uploads import contents as raw octet-stream bytes and commits a dry run', async () => {
    const api = createDocsApi(`http://127.0.0.1:${server.port}`, 'app-token');
    await api.putImportContent(
      'imp-1',
      'abc',
      new TextEncoder().encode('# A\n')
    );
    await api.commitImport('imp-1', true);
    expect(seen.map((s) => [s.method, s.path, s.type, s.body])).toEqual([
      [
        'PUT',
        '/api/docs/imports/imp-1/contents/abc',
        'application/octet-stream',
        '# A\n',
      ],
      [
        'POST',
        '/api/docs/imports/imp-1/commit?dryRun=1',
        'application/json',
        '{}',
      ],
    ]);
  });

  it('throws a CliError naming the field for other failures', async () => {
    const api = createDocsApi(`http://127.0.0.1:${server.port}`, 'app-token');
    await expect(api.get('missing')).rejects.toThrow(
      'doc missing not found (field: doc)'
    );
  });
});
